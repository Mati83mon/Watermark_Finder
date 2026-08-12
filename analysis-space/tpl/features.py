"""Stylometric feature extraction and lightweight language identification.

The feature vector is the only input the style classifier sees. Every feature is
a rate or a ratio so that the vector is length-invariant, and every feature is
documented in ``FEATURE_DOCS`` because the API exposes them to the UI.
"""

from __future__ import annotations

import re
import statistics
from collections.abc import Sequence
from dataclasses import dataclass, field

from .lexicons import (
    ASSISTANT_LEXICON,
    CONTRACTIONS,
    DISCOURSE_MARKERS,
    HEDGE_MARKERS,
    LANGUAGE_HINT_CHARS,
    STOPWORDS,
    markers_for,
)
from .segmenter import Span, split_paragraphs, split_sentences, words

MATTR_WINDOW = 50

#: Canonical feature order - the classifier relies on it.
FEATURE_ORDER: tuple[str, ...] = (
    "mean_sentence_length",
    "sentence_length_cv",
    "paragraph_length_cv",
    "mean_word_length",
    "long_word_ratio",
    "mattr",
    "hapax_ratio",
    "discourse_marker_rate",
    "assistant_lexicon_rate",
    "hedge_rate",
    "contraction_rate",
    "personal_pronoun_rate",
    "em_dash_rate",
    "curly_quote_ratio",
    "ellipsis_char_rate",
    "bullet_line_ratio",
    "sentence_start_repetition",
    "typo_indicator_rate",
    "comma_per_sentence",
    "exclamation_rate",
)

FEATURE_DOCS: dict[str, str] = {
    "mean_sentence_length": "Average sentence length in words.",
    "sentence_length_cv": "Coefficient of variation of sentence length ('burstiness'). Human prose varies more.",
    "paragraph_length_cv": "Coefficient of variation of paragraph length in words.",
    "mean_word_length": "Average word length in characters.",
    "long_word_ratio": "Share of words with 7 or more characters.",
    "mattr": "Moving-average type-token ratio over a 50-word window (lexical diversity).",
    "hapax_ratio": "Share of word types that occur exactly once.",
    "discourse_marker_rate": "Connectives such as 'moreover' / 'ponadto' per 100 words.",
    "assistant_lexicon_rate": "Register vocabulary favoured by instruction-tuned models, per 100 words.",
    "hedge_rate": "Hedging and disclaimer phrases per 100 words.",
    "contraction_rate": "English contractions per 100 words (English input only).",
    "personal_pronoun_rate": "First-person pronouns per 100 words.",
    "em_dash_rate": "Em dashes per 1000 characters.",
    "curly_quote_ratio": "Share of quotation marks that are typographic rather than straight.",
    "ellipsis_char_rate": "U+2026 ellipsis characters per 1000 characters.",
    "bullet_line_ratio": "Share of lines that start a bullet or numbered item.",
    "sentence_start_repetition": "Share of sentences whose opening word repeats an earlier opening word.",
    "typo_indicator_rate": "Spacing and punctuation slips per 1000 characters (double spaces, '!!', missing space after a comma).",
    "comma_per_sentence": "Average number of commas per sentence.",
    "exclamation_rate": "Exclamation marks per 1000 characters.",
}

_FIRST_PERSON = {
    "en": {"i", "me", "my", "mine", "myself", "we", "us", "our", "ours"},
    "pl": {"ja", "mnie", "mi", "mój", "moja", "moje", "my", "nas", "nam", "nasz", "nasza"},
}

_BULLET_RE = re.compile(r"^\s*(?:[-*•‣·]|\d+[.)]|[a-z][.)])\s+", re.MULTILINE)
_DOUBLE_SPACE_RE = re.compile(r"(?<=\S)  +(?=\S)")
_SPACE_BEFORE_PUNCT_RE = re.compile(r"\s+[,;:!?](?=\s|$)")
_REPEATED_PUNCT_RE = re.compile(r"[!?]{2,}|\.{4,}|,{2,}")
_MISSING_SPACE_RE = re.compile(r"[a-ząćęłńóśźż],[a-ząćęłńóśźż]")
_QUOTE_STRAIGHT = re.compile(r"[\"']")
_QUOTE_CURLY = re.compile(r"[‘’“”„«»]")


@dataclass
class LanguageGuess:
    code: str
    confidence: float
    scores: dict[str, float] = field(default_factory=dict)


def detect_language(text: str) -> LanguageGuess:
    """Identify the language from stopword coverage plus diacritic hints.

    Cheap and dependency free; accurate enough to pick the right marker lists,
    which is all it is used for.
    """
    tokens = [w.lower() for w in words(text)]
    if not tokens:
        return LanguageGuess("unknown", 0.0, {})

    sample = tokens[:2000]
    scores: dict[str, float] = {}
    lowered = text.lower()
    for code, stopwords in STOPWORDS.items():
        hits = sum(1 for token in sample if token in stopwords)
        score = hits / len(sample)
        hint_chars = LANGUAGE_HINT_CHARS.get(code)
        if hint_chars:
            hint_hits = sum(1 for ch in lowered if ch in hint_chars)
            score += min(0.15, hint_hits / max(len(lowered), 1) * 6.0)
        scores[code] = round(score, 4)

    best = max(scores, key=lambda key: scores[key])
    ordered = sorted(scores.values(), reverse=True)
    margin = ordered[0] - (ordered[1] if len(ordered) > 1 else 0.0)
    if scores[best] < 0.08:
        return LanguageGuess("unknown", round(scores[best] * 4, 3), scores)
    confidence = max(0.0, min(1.0, 0.5 + margin * 6))
    return LanguageGuess(best, round(confidence, 3), scores)


def _cv(values: Sequence[float]) -> float:
    """Coefficient of variation, 0.0 when it is not defined."""
    usable = [v for v in values if v > 0]
    if len(usable) < 2:
        return 0.0
    mean = statistics.fmean(usable)
    if mean <= 0:
        return 0.0
    return statistics.pstdev(usable) / mean


def _mattr(tokens: Sequence[str], window: int = MATTR_WINDOW) -> float:
    if not tokens:
        return 0.0
    if len(tokens) <= window:
        return len(set(tokens)) / len(tokens)
    ratios = [
        len(set(tokens[i : i + window])) / window
        for i in range(0, len(tokens) - window + 1, max(1, window // 5))
    ]
    return statistics.fmean(ratios)


def _phrase_hits(lowered: str, phrases) -> int:
    """Count marker occurrences; multi-word markers are matched as substrings."""
    total = 0
    for phrase in phrases:
        if " " in phrase:
            total += lowered.count(phrase)
    return total


def _token_hits(tokens: Sequence[str], phrases) -> int:
    single = {p for p in phrases if " " not in p}
    return sum(1 for token in tokens if token in single)


@dataclass
class FeatureSet:
    values: dict[str, float]
    language: str
    n_words: int
    n_sentences: int
    n_paragraphs: int
    n_chars: int

    def vector(self) -> list[float]:
        return [self.values[name] for name in FEATURE_ORDER]


def extract_features(text: str, language: str | None = None) -> FeatureSet:
    """Compute the full stylometric feature set for ``text``."""
    language = language or detect_language(text).code
    sentences: list[Span] = split_sentences(text)
    paragraphs: list[Span] = split_paragraphs(text)
    tokens = [w.lower() for w in words(text)]
    n_words = len(tokens)
    n_chars = max(len(text), 1)
    lowered = text.lower()

    per_100 = 100.0 / max(n_words, 1)
    per_1000_chars = 1000.0 / n_chars

    sentence_lengths = [s.word_count() for s in sentences]
    paragraph_lengths = [p.word_count() for p in paragraphs]

    counts = {}
    for token in tokens:
        counts[token] = counts.get(token, 0) + 1
    hapax = sum(1 for value in counts.values() if value == 1)

    discourse = markers_for(DISCOURSE_MARKERS, language)
    assistant = markers_for(ASSISTANT_LEXICON, language)
    hedges = markers_for(HEDGE_MARKERS, language)

    first_words = [
        (s.text.split()[0].lower().strip(".,;:—-") if s.text.split() else "") for s in sentences
    ]
    repeated_starts = 0
    seen: dict[str, int] = {}
    for word in first_words:
        if not word:
            continue
        seen[word] = seen.get(word, 0) + 1
        if seen[word] > 1:
            repeated_starts += 1

    typo_hits = (
        len(_DOUBLE_SPACE_RE.findall(text))
        + len(_SPACE_BEFORE_PUNCT_RE.findall(text))
        + len(_REPEATED_PUNCT_RE.findall(text))
        + len(_MISSING_SPACE_RE.findall(lowered))
    )

    straight_quotes = len(_QUOTE_STRAIGHT.findall(text))
    curly_quotes = len(_QUOTE_CURLY.findall(text))
    total_quotes = straight_quotes + curly_quotes

    lines = [line for line in text.splitlines() if line.strip()]
    bullet_lines = len(_BULLET_RE.findall(text))

    pronouns = _FIRST_PERSON.get(language, _FIRST_PERSON["en"])

    values: dict[str, float] = {
        "mean_sentence_length": statistics.fmean(sentence_lengths) if sentence_lengths else 0.0,
        "sentence_length_cv": _cv(sentence_lengths),
        "paragraph_length_cv": _cv(paragraph_lengths),
        "mean_word_length": statistics.fmean([len(t) for t in tokens]) if tokens else 0.0,
        "long_word_ratio": (sum(1 for t in tokens if len(t) >= 7) / n_words) if n_words else 0.0,
        "mattr": _mattr(tokens),
        "hapax_ratio": (hapax / len(counts)) if counts else 0.0,
        "discourse_marker_rate": (_token_hits(tokens, discourse) + _phrase_hits(lowered, discourse))
        * per_100,
        "assistant_lexicon_rate": (
            _token_hits(tokens, assistant) + _phrase_hits(lowered, assistant)
        )
        * per_100,
        "hedge_rate": (_token_hits(tokens, hedges) + _phrase_hits(lowered, hedges)) * per_100,
        "contraction_rate": (_token_hits(tokens, CONTRACTIONS) * per_100)
        if language == "en"
        else 0.0,
        "personal_pronoun_rate": _token_hits(tokens, pronouns) * per_100,
        "em_dash_rate": text.count("—") * per_1000_chars,
        "curly_quote_ratio": (curly_quotes / total_quotes) if total_quotes else 0.0,
        "ellipsis_char_rate": text.count("…") * per_1000_chars,
        "bullet_line_ratio": (bullet_lines / len(lines)) if lines else 0.0,
        "sentence_start_repetition": (repeated_starts / len(sentences)) if sentences else 0.0,
        "typo_indicator_rate": typo_hits * per_1000_chars,
        "comma_per_sentence": (text.count(",") / len(sentences)) if sentences else 0.0,
        "exclamation_rate": text.count("!") * per_1000_chars,
    }

    return FeatureSet(
        values={name: round(float(values[name]), 6) for name in FEATURE_ORDER},
        language=language,
        n_words=n_words,
        n_sentences=len(sentences),
        n_paragraphs=len(paragraphs),
        n_chars=len(text),
    )


__all__ = [
    "FEATURE_DOCS",
    "FEATURE_ORDER",
    "FeatureSet",
    "LanguageGuess",
    "detect_language",
    "extract_features",
]
