"""Watermark and covert-channel scoring.

A "watermark" here means any deliberate, machine-readable marker embedded in the
text. Two very different families are scored and kept apart in the output:

``covert_channel``
    Characters that do not render: zero-width codepoints, Unicode tag
    characters, variation-selector byte streams, bidi controls. A decoded
    payload is close to proof; a bare cluster of invisible characters is strong
    evidence.

``stylistic``
    Fingerprints that survive copy-paste but are not proof of anything on their
    own: typographic punctuation, uniform structure, n-gram recycling. These are
    reported with low weight so that a clean document never scores high on the
    strength of style alone.
"""

from __future__ import annotations

import re
import statistics
from collections.abc import Sequence
from dataclasses import dataclass, field

from .preprocessing import PreprocessResult
from .segmenter import words
from .unicode_tables import (
    CAT_BIDI,
    CAT_TAG,
    CAT_VARIATION_SELECTOR,
    CAT_ZERO_WIDTH,
)

CATEGORY_COVERT = "covert_channel"
CATEGORY_OBFUSCATION = "obfuscation"
CATEGORY_STYLISTIC = "stylistic"

SEVERITY_ORDER = ("info", "low", "medium", "high", "critical")


@dataclass
class Evidence:
    kind: str
    detail: str
    offset: int | None = None
    length: int = 1

    def as_dict(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            "detail": self.detail,
            "offset": self.offset,
            "length": self.length,
        }


@dataclass
class Signal:
    id: str
    category: str
    title: str
    description: str
    score: float
    weight: float
    severity: str
    evidence: list[Evidence] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "category": self.category,
            "title": self.title,
            "description": self.description,
            "score": round(self.score, 4),
            "weight": self.weight,
            "severity": self.severity,
            "evidence": [e.as_dict() for e in self.evidence[:25]],
            "evidence_total": len(self.evidence),
        }


def _severity_for(score: float) -> str:
    if score >= 0.85:
        return "critical"
    if score >= 0.65:
        return "high"
    if score >= 0.4:
        return "medium"
    if score >= 0.15:
        return "low"
    return "info"


def _count_score(count: int, thresholds: Sequence[tuple[int, float]]) -> float:
    """Map an occurrence count onto a score using explicit thresholds."""
    score = 0.0
    for minimum, value in thresholds:
        if count >= minimum:
            score = value
    return score


def _gap_regularity(offsets: Sequence[int]) -> float:
    """1.0 when hits are evenly spaced, 0.0 when spacing is random.

    Deliberate encodings distribute markers at mechanical intervals; incidental
    characters picked up from a web page do not.
    """
    if len(offsets) < 4:
        return 0.0
    gaps = [b - a for a, b in zip(offsets, offsets[1:], strict=False)]
    mean = statistics.fmean(gaps)
    if mean <= 0:
        return 0.0
    cv = statistics.pstdev(gaps) / mean
    return max(0.0, min(1.0, 1.0 - cv))


# --------------------------------------------------------------------------
# Individual detectors
# --------------------------------------------------------------------------
def _payload_signals(pre: PreprocessResult) -> list[Signal]:
    signals: list[Signal] = []
    for payload in pre.payloads:
        preview = payload.text if len(payload.text) <= 160 else payload.text[:157] + "..."
        signals.append(
            Signal(
                id=f"payload_{payload.channel}",
                category=CATEGORY_COVERT,
                title=f"Hidden payload decoded from {payload.channel.replace('_', ' ')}",
                description=(
                    f"{payload.byte_length} bytes were recovered from invisible characters "
                    f"and decode to readable text. {payload.note}".strip()
                ),
                score=0.97,
                weight=1.0,
                severity="critical",
                evidence=[
                    Evidence("payload", f"Decoded content: {preview}"),
                    Evidence(
                        "span",
                        f"{len(payload.offsets)} carrier characters between offsets "
                        f"{payload.offsets[0]} and {payload.offsets[-1]}",
                        offset=payload.offsets[0],
                        length=payload.offsets[-1] - payload.offsets[0] + 1,
                    ),
                ],
            )
        )
    return signals


def _invisible_signal(pre: PreprocessResult) -> Signal | None:
    hits = [
        h for h in pre.char_hits if h.category in (CAT_ZERO_WIDTH, CAT_TAG, CAT_VARIATION_SELECTOR)
    ]
    if not hits:
        return None

    offsets = [h.offset for h in hits]
    regularity = _gap_regularity(offsets)
    base = _count_score(
        len(hits),
        ((1, 0.45), (2, 0.6), (5, 0.75), (20, 0.88), (64, 0.94)),
    )
    score = min(0.99, base + 0.08 * regularity)

    by_name: dict[str, int] = {}
    for hit in hits:
        by_name[hit.label] = by_name.get(hit.label, 0) + 1
    summary = ", ".join(f"{name} x{count}" for name, count in sorted(by_name.items()))

    evidence = [Evidence("summary", summary)]
    if regularity > 0.5:
        evidence.append(
            Evidence(
                "pattern",
                f"Carrier characters are evenly spaced (regularity {regularity:.2f}), "
                "which is consistent with a deliberate encoding rather than copy-paste noise.",
            )
        )
    evidence.extend(
        Evidence("char", f"{hit.label} near: {hit.context}", offset=hit.offset) for hit in hits[:20]
    )

    return Signal(
        id="invisible_characters",
        category=CATEGORY_COVERT,
        title="Invisible characters embedded in the text",
        description=(
            f"{len(hits)} character(s) that render as nothing were found. Zero-width, tag "
            "and variation-selector codepoints are the standard carriers for text watermarks."
        ),
        score=score,
        weight=1.0,
        severity=_severity_for(score),
        evidence=evidence,
    )


def _bidi_signal(pre: PreprocessResult) -> Signal | None:
    hits = [h for h in pre.char_hits if h.category == CAT_BIDI]
    if not hits:
        return None
    score = _count_score(len(hits), ((1, 0.55), (2, 0.7), (6, 0.85)))
    return Signal(
        id="bidi_controls",
        category=CATEGORY_OBFUSCATION,
        title="Bidirectional control characters present",
        description=(
            "Bidi overrides can reorder how text is displayed without changing its bytes, "
            "which is used both for watermarking and for hiding content from a reader."
        ),
        score=score,
        weight=0.9,
        severity=_severity_for(score),
        evidence=[
            Evidence("char", f"{hit.label} near: {hit.context}", offset=hit.offset)
            for hit in hits[:20]
        ],
    )


def _homoglyph_signal(pre: PreprocessResult) -> Signal | None:
    hits = pre.homoglyphs
    if not hits:
        return None
    score = _count_score(len(hits), ((1, 0.5), (3, 0.68), (10, 0.85), (30, 0.93)))
    by_word: dict[str, int] = {}
    for hit in hits:
        by_word[hit.word] = by_word.get(hit.word, 0) + 1
    return Signal(
        id="homoglyph_substitution",
        category=CATEGORY_OBFUSCATION,
        title="Look-alike characters from another script",
        description=(
            f"{len(hits)} character(s) inside otherwise Latin words come from another script "
            "(Cyrillic, Greek or similar). Substituting look-alikes is a durable watermark "
            "because it survives reformatting and is invisible to a reader."
        ),
        score=score,
        weight=0.95,
        severity=_severity_for(score),
        evidence=[
            Evidence(
                "char",
                f"'{hit.char}' (U+{ord(hit.char):04X}, {hit.script}) used as '{hit.latin}' in \"{hit.word}\"",
                offset=hit.offset,
            )
            for hit in hits[:20]
        ]
        + [Evidence("summary", f"Affected words: {', '.join(sorted(by_word)[:12])}")],
    )


def _exotic_space_signal(pre: PreprocessResult) -> Signal | None:
    hits = [h for h in pre.char_hits if h.category == "exotic_space"]
    if not hits:
        return None
    # NBSP alone is common in text copied from the web, so keep the ceiling low
    # unless the spacing is mechanically regular.
    regularity = _gap_regularity([h.offset for h in hits])
    base = _count_score(len(hits), ((1, 0.12), (4, 0.25), (15, 0.4), (50, 0.55)))
    score = min(0.8, base + 0.25 * regularity)
    by_name: dict[str, int] = {}
    for hit in hits:
        by_name[hit.label] = by_name.get(hit.label, 0) + 1
    return Signal(
        id="exotic_whitespace",
        category=CATEGORY_OBFUSCATION,
        title="Unusual space characters",
        description=(
            "Non-breaking, narrow and other exotic spaces can encode information in the gaps "
            "between words. They also appear naturally in text copied from the web, so this "
            "signal is weighted conservatively."
        ),
        score=score,
        weight=0.5,
        severity=_severity_for(score),
        evidence=[Evidence("summary", ", ".join(f"{k} x{v}" for k, v in sorted(by_name.items())))],
    )


def _typography_signal(text: str) -> Signal | None:
    chars = max(len(text), 1)
    em_dash = text.count("—")
    ellipsis = text.count("…")
    curly = sum(text.count(ch) for ch in "‘’“”")
    straight = sum(text.count(ch) for ch in "\"'")
    nb_hyphen = text.count("‑")

    per_1k = 1000.0 / chars
    density = (em_dash + ellipsis + nb_hyphen) * per_1k
    curly_share = curly / (curly + straight) if (curly + straight) else 0.0

    score = min(0.75, density / 6.0 + curly_share * 0.35)
    if score < 0.12:
        return None
    return Signal(
        id="typographic_fingerprint",
        category=CATEGORY_STYLISTIC,
        title="Typographic punctuation profile",
        description=(
            "Em dashes, typographic quotes and the single-character ellipsis are produced by "
            "text generators far more often than by a keyboard. This is a stylistic hint, "
            "never proof on its own."
        ),
        score=score,
        weight=0.35,
        severity=_severity_for(score),
        evidence=[
            Evidence(
                "summary",
                f"em dash x{em_dash}, ellipsis char x{ellipsis}, non-breaking hyphen x{nb_hyphen}, "
                f"typographic quote share {curly_share:.0%}",
            )
        ],
    )


def _ngram_repetition_signal(text: str, n: int = 5) -> Signal | None:
    tokens = [w.lower() for w in words(text)]
    if len(tokens) < n * 8:
        return None
    grams: dict[tuple, int] = {}
    for i in range(len(tokens) - n + 1):
        gram = tuple(tokens[i : i + n])
        grams[gram] = grams.get(gram, 0) + 1
    repeated = {g: c for g, c in grams.items() if c > 1}
    if not repeated:
        return None
    total = len(tokens) - n + 1
    rate = sum(repeated.values()) / total
    score = min(0.7, rate * 5.0)
    if score < 0.12:
        return None
    top = sorted(repeated.items(), key=lambda item: -item[1])[:8]
    return Signal(
        id="ngram_recycling",
        category=CATEGORY_STYLISTIC,
        title="Repeated multi-word sequences",
        description=(
            f"{len(repeated)} distinct {n}-gram(s) occur more than once ({rate:.1%} of all "
            f"{n}-grams). Long-form generated text tends to recycle phrasing more than edited prose."
        ),
        score=score,
        weight=0.3,
        severity=_severity_for(score),
        evidence=[Evidence("ngram", f'"{" ".join(gram)}" x{count}') for gram, count in top],
    )


_HEADING_RE = re.compile(r"^\s*(#{1,6}\s+\S|\*\*[^*\n]+\*\*\s*$)", re.MULTILINE)


def _structure_signal(text: str) -> Signal | None:
    lines = [line for line in text.splitlines() if line.strip()]
    if len(lines) < 6:
        return None
    bullets = sum(1 for line in lines if re.match(r"^\s*(?:[-*•]|\d+[.)])\s+", line))
    headings = len(_HEADING_RE.findall(text))
    bold_runs = text.count("**") // 2
    structure_rate = (bullets + headings) / len(lines)
    score = min(0.6, structure_rate * 0.9 + min(bold_runs, 12) * 0.02)
    if score < 0.15:
        return None
    return Signal(
        id="structural_uniformity",
        category=CATEGORY_STYLISTIC,
        title="Heavily structured, list-driven layout",
        description=(
            "Dense bullet lists, headings and bold runs are a hallmark of assistant output "
            "pasted verbatim. Legitimate documentation looks the same, so the weight is low."
        ),
        score=score,
        weight=0.25,
        severity=_severity_for(score),
        evidence=[
            Evidence(
                "summary",
                f"{bullets} bullet line(s), {headings} heading(s), {bold_runs} bold run(s) "
                f"across {len(lines)} non-empty lines",
            )
        ],
    )


# --------------------------------------------------------------------------
# Aggregation
# --------------------------------------------------------------------------
@dataclass
class WatermarkResult:
    score: float
    label: str
    confidence: str
    signals: list[Signal]
    #: Where the score came from, so a caller never presents a stylistic guess
    #: as byte-level proof:
    #:
    #: ``bytes``      at least one covert-channel or obfuscation signal fired,
    #:                so the number rests on characters actually present.
    #: ``stylistic``  only soft signals fired. Nothing was found in the bytes;
    #:                the score is a weak stylistic hint and cannot exceed the
    #:                0.45 cap applied below.
    #: ``none``       no signal fired at all.
    basis: str = "none"

    @property
    def covert_signals(self) -> list[Signal]:
        return [s for s in self.signals if s.category == CATEGORY_COVERT]


def _label_for(score: float, has_payload: bool) -> str:
    if has_payload:
        return "payload_recovered"
    if score >= 0.8:
        return "watermark_detected"
    if score >= 0.5:
        return "watermark_suspected"
    if score >= 0.2:
        return "weak_indicators"
    return "clean"


def analyse_watermarks(pre: PreprocessResult) -> WatermarkResult:
    """Run every detector over a preprocessed document and aggregate."""
    text = pre.normalized
    signals: list[Signal] = []
    signals.extend(_payload_signals(pre))
    for detector in (_invisible_signal, _bidi_signal, _homoglyph_signal, _exotic_space_signal):
        signal = detector(pre)
        if signal is not None:
            signals.append(signal)
    for detector in (_typography_signal, _ngram_repetition_signal, _structure_signal):
        signal = detector(text)
        if signal is not None:
            signals.append(signal)

    hard = [s for s in signals if s.category in (CATEGORY_COVERT, CATEGORY_OBFUSCATION)]
    soft = [s for s in signals if s.category == CATEGORY_STYLISTIC]

    hard_score = 0.0
    if hard:
        ordered = sorted(hard, key=lambda s: -(s.score * s.weight))
        hard_score = ordered[0].score * ordered[0].weight
        # Additional independent channels raise confidence, with diminishing returns.
        for extra in ordered[1:]:
            hard_score += (1.0 - hard_score) * extra.score * extra.weight * 0.5

    soft_score = 0.0
    if soft:
        weight_sum = sum(s.weight for s in soft)
        soft_score = sum(s.score * s.weight for s in soft) / weight_sum

    # Style alone can never claim a watermark; it is capped well below the
    # "suspected" threshold.
    score = max(hard_score, soft_score * 0.45)
    score = max(0.0, min(0.99, score))

    if hard:
        basis = "bytes"
    elif soft:
        basis = "stylistic"
    else:
        basis = "none"

    has_payload = any(s.id.startswith("payload_") for s in signals)
    if has_payload:
        score = max(score, 0.95)

    if has_payload or score >= 0.8:
        confidence = "high"
    elif score >= 0.5:
        confidence = "medium"
    else:
        confidence = "low"

    signals.sort(key=lambda s: (-(SEVERITY_ORDER.index(s.severity)), -s.score))
    return WatermarkResult(
        score=round(score, 4),
        label=_label_for(score, has_payload),
        confidence=confidence,
        signals=signals,
        basis=basis,
    )


__all__ = [
    "CATEGORY_COVERT",
    "CATEGORY_OBFUSCATION",
    "CATEGORY_STYLISTIC",
    "Evidence",
    "Signal",
    "WatermarkResult",
    "analyse_watermarks",
]
