"""End-to-end analysis pipeline.

``analyse`` is the only entry point the API needs. It is pure Python and
returns plain dictionaries, so it can be exercised from tests, a CLI or a
notebook without starting the web server.

Segment offsets are computed against the *original* string the caller supplied,
so the frontend can highlight fragments without any offset translation.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Literal

from .config import SCHEMA_VERSION, VERSION, get_settings
from .features import FEATURE_DOCS, extract_features
from .llm_classifier import StyleModel, load_model, model_metrics
from .model_profiles import DISCLAIMER, profile_text
from .perplexity import analyse as analyse_perplexity
from .preprocessing import preprocess, strip_invisible
from .report_builder import (
    build_findings,
    build_markdown_report,
    compute_risk,
    risk_label,
)
from .segmenter import sliding_windows
from .watermark_heuristics import analyse_watermarks

Mode = Literal["quick", "forensic"]

#: Per-mode segmentation and feature toggles.
MODE_SETTINGS: dict[str, dict[str, Any]] = {
    "quick": {
        "window_words": 250,
        "overlap_words": 0,
        "max_segments": 25,
        "profiles": False,
        "perplexity": False,
    },
    "forensic": {
        "window_words": None,  # falls back to the configured default
        "overlap_words": None,
        "max_segments": None,
        "profiles": True,
        "perplexity": True,
    },
}

#: How much weight the optional surprisal signal gets when it is available.
PERPLEXITY_BLEND = 0.3

#: Containers that cannot carry zero-width characters through to extraction.
#:
#: PDF stores positioned glyphs, not a character stream, so a codepoint with no
#: glyph simply has nothing to store. Measured directly: a PDF built with
#: U+200B and U+200D in its text extracts back with zero of either. A clean
#: covert-channel result on such a source therefore carries no information, and
#: saying so is the difference between a useful answer and a misleading one.
LOSSY_SOURCE_FORMATS: dict[str, str] = {
    "pdf": (
        "The text came from a PDF. PDF cannot carry zero-width or tag characters "
        "through extraction, so a clean covert-channel result here proves nothing "
        "about the original document. Submit the text directly, or as .txt or "
        ".docx, to test for hidden characters."
    ),
    "html": (
        "The text came from HTML. Markup stripping can drop invisible characters, "
        "so a clean covert-channel result is weaker evidence than it looks."
    ),
}


class AnalysisError(ValueError):
    """Raised for input the pipeline refuses to process."""


@dataclass
class _Timer:
    marks: dict[str, float]
    _start: float

    @classmethod
    def start(cls) -> _Timer:
        return cls(marks={}, _start=time.perf_counter())

    def mark(self, name: str) -> None:
        now = time.perf_counter()
        self.marks[name] = round((now - self._start) * 1000, 2)
        self._start = now

    def total(self, began: float) -> float:
        return round((time.perf_counter() - began) * 1000, 2)


def _segment_label(value: float) -> str:
    if value >= 0.75:
        return "assistant"
    if value >= 0.55:
        return "leaning_assistant"
    if value <= 0.3:
        return "human"
    if value <= 0.45:
        return "leaning_human"
    return "mixed"


def _build_segments(
    text: str,
    language: str,
    model: StyleModel,
    hit_offsets: list[int],
    window_words: int,
    overlap_words: int,
    max_segments: int,
) -> list[dict[str, Any]]:
    windows = sliding_windows(text, target_words=window_words, overlap_words=overlap_words)
    if len(windows) > max_segments:
        # Re-segment with proportionally larger windows instead of truncating,
        # so the whole document stays covered.
        scale = len(windows) / max_segments
        windows = sliding_windows(
            text,
            target_words=int(window_words * scale) + 1,
            overlap_words=min(overlap_words, int(window_words * scale) // 2),
        )[:max_segments]

    segments: list[dict[str, Any]] = []
    for index, window in enumerate(windows):
        cleaned = strip_invisible(window.text)
        features = extract_features(cleaned, language)
        score = model.predict(features)
        hits = sum(1 for offset in hit_offsets if window.start <= offset < window.end)
        preview = cleaned.strip().replace("\n", " ")
        segments.append(
            {
                "index": index,
                "start": window.start,
                "end": window.end,
                "word_count": features.n_words,
                "preview": preview[:180] + ("..." if len(preview) > 180 else ""),
                "llm_likelihood": round(score.value, 4),
                "label": _segment_label(score.value),
                "watermark_hits": hits,
            }
        )
    return segments


def analyse(
    text: str,
    mode: Mode = "forensic",
    *,
    model: StyleModel | None = None,
    source_format: str | None = None,
) -> dict[str, Any]:
    """Run the full analysis and return the API payload.

    ``source_format`` names the container the text was extracted from ("pdf",
    "docx", "text", ...). It changes no score - it only lets the result say when
    the input format has already destroyed what the caller is asking about.
    """
    settings = get_settings()
    if not isinstance(text, str):
        raise AnalysisError("text must be a string")
    if not text.strip():
        raise AnalysisError("text is empty")
    if len(text) > settings.max_chars:
        raise AnalysisError(f"text is {len(text)} characters, the limit is {settings.max_chars}")
    if mode not in MODE_SETTINGS:
        raise AnalysisError(f"unknown mode '{mode}'")

    mode_settings = MODE_SETTINGS[mode]
    window_words = mode_settings["window_words"] or settings.window_words
    overlap_words = (
        settings.window_overlap
        if mode_settings["overlap_words"] is None
        else mode_settings["overlap_words"]
    )
    max_segments = mode_settings["max_segments"] or settings.max_segments

    began = time.perf_counter()
    timer = _Timer.start()
    warnings: list[str] = []

    pre = preprocess(text)
    timer.mark("preprocess")

    features = extract_features(pre.cleaned)
    timer.mark("features")

    watermark = analyse_watermarks(pre)
    timer.mark("watermarks")

    active_model = model or load_model()
    style = active_model.predict(features)
    timer.mark("classifier")

    perplexity = {"available": False, "reason": "not requested"}
    if mode_settings["perplexity"]:
        result = analyse_perplexity(pre.cleaned)
        perplexity = result.as_dict()
        if result.available:
            blended = (1 - PERPLEXITY_BLEND) * style.value + PERPLEXITY_BLEND * result.signal
            style.value = round(max(0.02, min(0.98, blended)), 4)
            style.low = max(0.0, style.low - 0.02)
            style.high = min(1.0, style.high + 0.02)
            style.notes.append(
                f"Blended with local surprisal from {result.model} "
                f"(weight {PERPLEXITY_BLEND:.0%})."
            )
    timer.mark("perplexity")

    hit_offsets = [hit.offset for hit in pre.invisible_hits] + [
        hit.offset for hit in pre.homoglyphs
    ]
    segments = _build_segments(
        pre.original,
        features.language,
        active_model,
        hit_offsets,
        window_words,
        overlap_words,
        max_segments,
    )
    timer.mark("segments")

    profiles = profile_text(pre.cleaned, features) if mode_settings["profiles"] else []

    findings = build_findings(pre, watermark, style)
    risk = compute_risk(watermark, style)

    if features.n_words < 40:
        warnings.append("Fewer than 40 words: treat every probabilistic score as indicative only.")
    if pre.scripts and len(pre.scripts) > 2:
        warnings.append(
            "The document mixes more than two scripts, which can distort stylometric features."
        )
    lossy = LOSSY_SOURCE_FORMATS.get((source_format or "").lower())
    if lossy and watermark.label in ("clean", "weak_indicators"):
        warnings.append(lossy)

    report = build_markdown_report(
        pre=pre,
        features=features,
        watermark=watermark,
        style=style,
        findings=findings,
        segments=segments,
        profiles=profiles,
        risk=risk,
        perplexity=perplexity,
        engine_version=VERSION,
    )
    timer.mark("report")

    return {
        "schema_version": SCHEMA_VERSION,
        "engine": {
            "name": "text-provenance-lab",
            "version": VERSION,
            "mode": mode,
            "style_model": style.model_id,
            "style_model_trained": style.trained,
        },
        "input": {
            "chars": features.n_chars_source,
            "words": features.n_words_source,
            "chars_measured": features.n_chars,
            "words_measured": features.n_words,
            "sentences": features.n_sentences,
            "paragraphs": features.n_paragraphs,
            "language": features.language,
            "scripts": pre.scripts,
            "sha256": pre.sha256,
            "source_format": source_format,
        },
        "scores": {
            "llm_likelihood": style.as_dict(),
            "watermark": {
                "value": watermark.score,
                "label": watermark.label,
                "confidence": watermark.confidence,
                "basis": watermark.basis,
            },
            "risk": {"value": risk, "label": risk_label(risk)},
        },
        "signals": [signal.as_dict() for signal in watermark.signals],
        "payloads": [
            {
                "channel": payload.channel,
                "text": payload.text,
                "byte_length": payload.byte_length,
                "printable_ratio": round(payload.printable_ratio, 4),
                "carrier_count": len(payload.offsets),
                "first_offset": payload.offsets[0],
                "last_offset": payload.offsets[-1],
                "note": payload.note,
            }
            for payload in pre.payloads
        ],
        "segments": segments,
        "style_profiles": {"disclaimer": DISCLAIMER, "matches": profiles},
        "features": {
            "values": features.values,
            "docs": FEATURE_DOCS,
        },
        "perplexity": perplexity,
        "findings": [finding.as_dict() for finding in findings],
        "technical_report_markdown": report,
        "warnings": warnings,
        "timings_ms": {**timer.marks, "total": timer.total(began)},
        "model_metrics": model_metrics(),
    }


__all__ = ["AnalysisError", "MODE_SETTINGS", "Mode", "analyse"]
