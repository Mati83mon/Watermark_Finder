"""Read C2PA content credentials out of a file.

C2PA is the industry standard for signed provenance metadata: a manifest
embedded in a file saying what produced it and what was done to it, signed with
an ordinary X.509 certificate chain. Anthropic attaches one to files Claude
produces, as do Adobe, Leica, Google and others.

Unlike the sampling watermark, verification needs no secret. The signature is
checked against the certificate embedded in the file, and the certificate is
checked against public trust anchors. That makes this the one provenance signal
in the modern stack that a third-party tool can actually verify, which is why
it is here.

The distinction this module exists to preserve
----------------------------------------------
The underlying library reports three states, and collapsing them into a single
"verified" tick would be a lie in both directions::

    Trusted   hashes match AND the signer chains to a recognised anchor
    Valid     hashes match, signer is NOT recognised
    Invalid   a hash or a signature did not check out

`Valid` is the trap. Anyone can mint a certificate whose common name reads
"Adobe Inc." and sign a file with it; the manifest then validates perfectly and
claims whatever its author wanted. Reporting that as verified provenance would
turn this tool into a laundering service for forged credentials.

So integrity and trust are reported as separate fields, and a caller cannot
render one without the other.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

#: IPTC digital source type meaning "made by a generative model". This is the
#: standard way a C2PA manifest declares AI authorship.
AI_SOURCE_TYPES = (
    "trainedAlgorithmicMedia",
    "compositeWithTrainedAlgorithmicMedia",
    "algorithmicMedia",
)

_STATE_INTEGRITY = {
    "Trusted": "intact",
    "Valid": "intact",
    "Invalid": "broken",
}
_STATE_TRUST = {
    "Trusted": "recognised",
    "Valid": "unrecognised",
    "Invalid": "unknown",
}


class ProvenanceUnavailable(RuntimeError):
    """The C2PA library is not installed in this deployment."""


@dataclass
class C2paResult:
    present: bool
    #: intact | broken | unknown
    integrity: str = "unknown"
    #: recognised | unrecognised | unknown
    trust: str = "unknown"
    raw_state: str | None = None
    generator: str | None = None
    signer_common_name: str | None = None
    signer_issuer: str | None = None
    signature_alg: str | None = None
    title: str | None = None
    embedded: bool | None = None
    #: True when the manifest declares generative-AI authorship, False when it
    #: declares something else, None when it says nothing either way.
    ai_declared: bool | None = None
    actions: list[str] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    reason: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "present": self.present,
            "integrity": self.integrity,
            "trust": self.trust,
            "raw_state": self.raw_state,
            "generator": self.generator,
            "signer_common_name": self.signer_common_name,
            "signer_issuer": self.signer_issuer,
            "signature_alg": self.signature_alg,
            "title": self.title,
            "embedded": self.embedded,
            "ai_declared": self.ai_declared,
            "actions": self.actions,
            "failures": self.failures,
            "notes": self.notes,
            "reason": self.reason,
        }


def is_available() -> bool:
    try:
        import c2pa  # noqa: F401
    except Exception:
        return False
    return True


def supported_mime_types() -> list[str]:
    try:
        import c2pa
    except Exception:
        return []
    try:
        return sorted({t for t in c2pa.Reader.get_supported_mime_types() if "/" in t})
    except Exception:  # pragma: no cover - library detail
        return []


def _classify_actions(manifest: dict[str, Any]) -> tuple[list[str], bool | None]:
    labels: list[str] = []
    declared: bool | None = None
    for assertion in manifest.get("assertions") or []:
        if not str(assertion.get("label", "")).startswith("c2pa.actions"):
            continue
        for action in (assertion.get("data") or {}).get("actions") or []:
            name = action.get("action")
            if name:
                labels.append(name)
            source = action.get("digitalSourceType")
            if not source:
                continue
            tail = source.rsplit("/", 1)[-1]
            if tail in AI_SOURCE_TYPES:
                declared = True
            elif declared is None:
                declared = False
    return labels, declared


def inspect_bytes(data: bytes, mime_type: str) -> C2paResult:
    """Read the content credential in ``data``, if there is one.

    Never raises for ordinary outcomes: a file with no manifest, an unsupported
    format and a corrupt manifest all come back as a result explaining itself.
    """
    try:
        import c2pa
    except Exception as exc:  # pragma: no cover - deployment detail
        raise ProvenanceUnavailable(str(exc)) from exc

    import io

    try:
        with c2pa.Reader(mime_type, io.BytesIO(data)) as reader:
            payload = json.loads(reader.json())
            state = reader.get_validation_state()
            try:
                embedded = reader.is_embedded()
            except Exception:  # pragma: no cover - library detail
                embedded = None
            try:
                results = reader.get_validation_results() or {}
            except Exception:  # pragma: no cover - library detail
                results = {}
    except Exception as exc:
        text = str(exc)
        if "ManifestNotFound" in type(exc).__name__ or "no JUMBF" in text:
            return C2paResult(present=False, reason="no content credential in this file")
        if "NotSupported" in type(exc).__name__ or "not supported" in text.lower():
            return C2paResult(
                present=False, reason=f"C2PA does not cover {mime_type} files"
            )
        logger.info("c2pa read failed for %s: %s", mime_type, text)
        return C2paResult(
            present=False, reason=f"the file could not be read as {mime_type}"
        )

    active = (payload.get("manifests") or {}).get(payload.get("active_manifest") or "", {})
    signature = active.get("signature_info") or {}
    generators = active.get("claim_generator_info") or []
    actions, ai_declared = _classify_actions(active)

    failures = [
        f.get("code", "")
        for f in ((results.get("activeManifest") or {}).get("failure") or [])
    ]

    result = C2paResult(
        present=True,
        integrity=_STATE_INTEGRITY.get(state, "unknown"),
        trust=_STATE_TRUST.get(state, "unknown"),
        raw_state=state,
        generator=(generators[0].get("name") if generators else None),
        signer_common_name=signature.get("common_name"),
        signer_issuer=signature.get("issuer"),
        signature_alg=signature.get("alg"),
        title=active.get("title"),
        embedded=embedded,
        ai_declared=ai_declared,
        actions=actions,
        failures=failures,
    )

    if result.trust == "unrecognised":
        result.notes.append(
            "The signature checks out, but the signing certificate is not on a "
            "recognised trust list. Anyone can issue a certificate naming any "
            "organisation, so treat the claimed origin as unverified."
        )
    if result.integrity == "broken":
        result.notes.append(
            "The file does not match what was signed. It was modified after the "
            "credential was attached, or the credential is corrupt."
        )
    if result.ai_declared:
        result.notes.append(
            "The credential itself declares generative-AI authorship "
            "(IPTC digitalSourceType)."
        )
    return result


def inspect_absent(reason: str) -> C2paResult:
    """A result for callers that could not even attempt a read."""
    return C2paResult(present=False, reason=reason)


__all__ = [
    "C2paResult",
    "ProvenanceUnavailable",
    "inspect_bytes",
    "inspect_absent",
    "is_available",
    "supported_mime_types",
]
