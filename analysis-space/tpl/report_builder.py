"""Findings and the human-readable technical report.

The report is Markdown so the frontend can render it, print it, or export it to
PDF without any server-side rendering. Every number in it comes from the
analysis result - nothing is templated in as a placeholder.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .features import FEATURE_DOCS, FeatureSet
from .llm_classifier import (
    LABEL_AI,
    LABEL_HUMAN,
    LABEL_INSUFFICIENT,
    LABEL_STRONG_AI,
    StyleScore,
)
from .model_profiles import DISCLAIMER
from .preprocessing import PreprocessResult
from .watermark_heuristics import Signal, WatermarkResult

RISK_LABELS = (
    (0.8, "critical"),
    (0.6, "high"),
    (0.35, "medium"),
    (0.15, "low"),
    (0.0, "minimal"),
)


@dataclass
class Finding:
    id: str
    severity: str
    title: str
    detail: str
    recommendation: str

    def as_dict(self) -> dict[str, str]:
        return {
            "id": self.id,
            "severity": self.severity,
            "title": self.title,
            "detail": self.detail,
            "recommendation": self.recommendation,
        }


def risk_label(score: float) -> str:
    for threshold, label in RISK_LABELS:
        if score >= threshold:
            return label
    return "minimal"


def compute_risk(watermark: WatermarkResult, style: StyleScore) -> float:
    """Combine both verdicts into a single triage number.

    A recovered payload dominates: a document carrying a hidden message is a
    problem regardless of who wrote it. Style contributes a smaller share
    because it is inherently probabilistic.
    """
    if style.label == LABEL_INSUFFICIENT:
        # No usable style evidence: risk rests on the watermark verdict alone.
        base = 0.85 * watermark.score
    else:
        base = 0.75 * watermark.score + 0.25 * max(0.0, style.value - 0.5) * 2
    if watermark.label == "payload_recovered":
        # A decoded payload is a fact about the bytes; a short sample does not
        # make it less true, so the floor is applied last.
        base = max(base, 0.9)
    return round(max(0.0, min(1.0, base)), 4)


def build_findings(
    pre: PreprocessResult,
    watermark: WatermarkResult,
    style: StyleScore,
) -> list[Finding]:
    findings: list[Finding] = []

    for payload in pre.payloads:
        preview = payload.text if len(payload.text) <= 200 else payload.text[:197] + "..."
        findings.append(
            Finding(
                id=f"payload-{payload.channel}",
                severity="critical",
                title=f"Hidden message recovered from {payload.channel.replace('_', ' ')}",
                detail=(
                    f"{payload.byte_length} bytes of readable content were carried by "
                    f'{len(payload.offsets)} invisible characters. Decoded content: "{preview}".'
                ),
                recommendation=(
                    "Treat the document as tagged. Strip the carrier characters before "
                    "redistributing it, and preserve the original for evidence."
                ),
            )
        )

    for signal in watermark.signals:
        if signal.id.startswith("payload_") or signal.severity in ("info", "low"):
            continue
        findings.append(
            Finding(
                id=f"signal-{signal.id}",
                severity=signal.severity,
                title=signal.title,
                detail=signal.description,
                recommendation=_recommendation_for(signal),
            )
        )

    if style.label in (LABEL_AI, LABEL_STRONG_AI):
        findings.append(
            Finding(
                id="style-assistant-register",
                severity="medium" if style.label == LABEL_AI else "high",
                title="Text reads as unedited assistant output",
                detail=(
                    f"Style score {style.value:.2f} (band {style.low:.2f}-{style.high:.2f}, "
                    f"confidence {style.confidence}), produced by {style.model_id}."
                ),
                recommendation=(
                    "Use this as a prompt for review, not as proof. Corroborate with document "
                    "history, drafts or authorship metadata before acting on it."
                ),
            )
        )
    elif style.label == LABEL_HUMAN:
        findings.append(
            Finding(
                id="style-human-register",
                severity="info",
                title="Stylometry leans human",
                detail=(
                    f"Style score {style.value:.2f} (band {style.low:.2f}-{style.high:.2f}). "
                    "Sentence rhythm and error profile are consistent with human writing."
                ),
                recommendation="No action required from the stylometric side.",
            )
        )
    elif style.label == LABEL_INSUFFICIENT:
        findings.append(
            Finding(
                id="style-insufficient",
                severity="info",
                title="Not enough text for a stylometric verdict",
                detail=(
                    "Stylometric features are unstable below roughly 150 words; the score "
                    "was pulled towards 0.5 to reflect that."
                ),
                recommendation="Supply a longer sample if a style verdict is needed.",
            )
        )

    order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    findings.sort(key=lambda f: order.get(f.severity, 5))
    return findings


def _recommendation_for(signal: Signal) -> str:
    return {
        "invisible_characters": (
            "Normalise the text (strip zero-width, tag and variation-selector codepoints) "
            "before publishing, and check whether the source system adds them deliberately."
        ),
        "bidi_controls": (
            "Render the document with bidi controls stripped and compare; the displayed text "
            "may differ from the stored bytes."
        ),
        "homoglyph_substitution": (
            "Map the affected characters back to Latin and diff against the original to see "
            "what the substitution pattern encodes."
        ),
        "exotic_whitespace": (
            "Collapse exotic spaces to U+0020 if the document is going to be republished."
        ),
        "typographic_fingerprint": "Informational only - do not act on typography alone.",
        "ngram_recycling": "Review the repeated phrases for template reuse.",
        "structural_uniformity": "Informational only - documentation legitimately looks like this.",
    }.get(signal.id, "Review the evidence attached to this signal.")


def _fmt_pct(value: float) -> str:
    return f"{value * 100:.1f}%"


def build_markdown_report(
    pre: PreprocessResult,
    features: FeatureSet,
    watermark: WatermarkResult,
    style: StyleScore,
    findings: Sequence[Finding],
    segments: Sequence[dict[str, object]],
    profiles: Sequence[dict[str, object]],
    risk: float,
    perplexity: dict[str, object],
    engine_version: str,
) -> str:
    lines: list[str] = []
    add = lines.append

    add("# Text provenance report")
    add("")
    add(f"- **Engine**: text-provenance-lab {engine_version}")
    add(f"- **Document SHA-256**: `{pre.sha256}`")
    add(
        f"- **Size**: {features.n_chars_source} characters, "
        f"{features.n_words_source} words"
        + (
            f" ({features.n_chars} characters of prose measured; "
            f"{features.excluded_chars} in fenced code blocks were excluded)"
            if features.excluded_chars
            else f", {features.n_sentences} sentences, {features.n_paragraphs} paragraphs"
        )
    )
    add(f"- **Detected language**: {features.language}")
    add(f"- **Overall risk**: {_fmt_pct(risk)} ({risk_label(risk)})")
    add("")

    add("## Verdicts")
    add("")
    add("| Dimension | Score | Label | Confidence |")
    add("| --- | --- | --- | --- |")
    add(
        f"| Watermark / covert channel | {_fmt_pct(watermark.score)} | "
        f"{watermark.label.replace('_', ' ')} | {watermark.confidence} |"
    )
    add(
        f"| Assistant-register style | {_fmt_pct(style.value)} "
        f"({_fmt_pct(style.low)}-{_fmt_pct(style.high)}) | "
        f"{style.label.replace('_', ' ')} | {style.confidence} |"
    )
    add("")

    if pre.payloads:
        add("## Recovered payloads")
        add("")
        for payload in pre.payloads:
            add(f"### Channel: {payload.channel.replace('_', ' ')}")
            add("")
            add(f"- Carrier characters: {len(payload.offsets)}")
            add(f"- Decoded length: {payload.byte_length} bytes")
            add(f"- First carrier at offset {payload.offsets[0]}")
            add("")
            add("```")
            add(payload.text[:2000])
            add("```")
            add("")

    add("## Signals")
    add("")
    if not watermark.signals:
        add("No watermark or obfuscation signals fired.")
        add("")
    else:
        add("| Signal | Category | Score | Severity |")
        add("| --- | --- | --- | --- |")
        for signal in watermark.signals:
            add(
                f"| {signal.title} | {signal.category} | {_fmt_pct(signal.score)} | {signal.severity} |"
            )
        add("")
        for signal in watermark.signals:
            add(f"### {signal.title}")
            add("")
            add(signal.description)
            add("")
            for evidence in signal.evidence[:10]:
                location = f" (offset {evidence.offset})" if evidence.offset is not None else ""
                add(f"- {evidence.detail}{location}")
            if len(signal.evidence) > 10:
                add(f"- ... and {len(signal.evidence) - 10} more")
            add("")

    add("## Findings")
    add("")
    if not findings:
        add("Nothing to report.")
        add("")
    for finding in findings:
        add(f"### [{finding.severity.upper()}] {finding.title}")
        add("")
        add(finding.detail)
        add("")
        add(f"**Recommended action**: {finding.recommendation}")
        add("")

    add("## Style analysis")
    add("")
    add(f"Model: `{style.model_id}` (trained on a corpus: {'yes' if style.trained else 'no'}).")
    add("")
    if style.contributions:
        add("Strongest contributions to the score:")
        add("")
        add("| Feature | Value | z | Log-odds | Points towards |")
        add("| --- | --- | --- | --- | --- |")
        for contribution in style.contributions:
            direction = "assistant" if contribution.contribution > 0 else "human"
            add(
                f"| {contribution.feature} | {contribution.value:.3f} | {contribution.z:+.2f} | "
                f"{contribution.contribution:+.3f} | {direction} |"
            )
        add("")
    for note in style.notes:
        add(f"> {note}")
        add("")

    if perplexity.get("available"):
        add("### Language-model surprisal")
        add("")
        add(f"- Model: `{perplexity.get('model')}`")
        add(f"- Mean surprisal: {perplexity.get('mean_surprisal')} nats/token")
        add(f"- Surprisal CV (burstiness): {perplexity.get('surprisal_cv')}")
        add(f"- Perplexity: {perplexity.get('perplexity')}")
        add(f"- Derived signal: {perplexity.get('signal')}")
        add("")

    if profiles:
        add("## Style resemblance")
        add("")
        add(f"> {DISCLAIMER}")
        add("")
        add("| Profile | Similarity | Why |")
        add("| --- | --- | --- |")
        for profile in profiles:
            add(
                f"| {profile['label']} | {_fmt_pct(float(profile['similarity']))} | {profile['rationale']} |"
            )
        add("")

    add("## Segment breakdown")
    add("")
    if segments:
        add("| # | Range | Words | Style score | Watermark hits |")
        add("| --- | --- | --- | --- | --- |")
        for segment in segments[:40]:
            add(
                f"| {segment['index']} | {segment['start']}-{segment['end']} | "
                f"{segment['word_count']} | {_fmt_pct(float(segment['llm_likelihood']))} | "
                f"{segment['watermark_hits']} |"
            )
        if len(segments) > 40:
            add(f"| ... | | | | {len(segments) - 40} more segments |")
        add("")
    else:
        add("Document too short to segment.")
        add("")

    add("## Feature values")
    add("")
    add("| Feature | Value | Meaning |")
    add("| --- | --- | --- |")
    for name, value in features.values.items():
        add(f"| {name} | {value:.4f} | {FEATURE_DOCS.get(name, '')} |")
    add("")

    add("## Method and limitations")
    add("")
    add(
        "- Covert-channel detection is deterministic: a decoded payload or a cluster of "
        "invisible codepoints is a fact about the bytes, not an inference."
    )
    add(
        "- Stylometry is probabilistic. It measures register, not authorship, and it is "
        "unreliable below roughly 150 words, on translated text, and on heavily edited output."
    )
    add(
        "- Absence of a watermark proves nothing: normalising a document removes every "
        "covert channel this tool can see."
    )
    add(
        "- Do not use the style score as the sole basis for an accusation, a grade or a "
        "disciplinary decision."
    )
    add("")

    return "\n".join(lines)


__all__ = [
    "Finding",
    "build_findings",
    "build_markdown_report",
    "compute_risk",
    "risk_label",
]
