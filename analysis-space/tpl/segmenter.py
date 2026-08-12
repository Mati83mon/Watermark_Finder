"""Sentence, paragraph and sliding-window segmentation.

Offsets are always character offsets into the string that was passed in, so the
frontend can map a segment score back onto the exact fragment it highlights.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass

#: Abbreviations that must not end a sentence. Kept small and explicit - a big
#: list would be language specific and is not worth the false-negative risk.
_ABBREVIATIONS = {
    # English
    "mr",
    "mrs",
    "ms",
    "dr",
    "prof",
    "st",
    "vs",
    "etc",
    "e.g",
    "i.e",
    "fig",
    "no",
    "approx",
    # Polish
    "np",
    "itp",
    "itd",
    "tzn",
    "tj",
    "dr hab",
    "ul",
    "godz",
    "mln",
    "mld",
    "ok",
}

_SENTENCE_END = re.compile(r"[.!?…]+[\"'”’)\]]*\s+|\n{2,}")
_WORD_RE = re.compile(r"[^\W\d_]+(?:['’-][^\W\d_]+)*", re.UNICODE)
_TOKEN_RE = re.compile(r"\S+")


@dataclass(frozen=True)
class Span:
    start: int
    end: int
    text: str

    @property
    def length(self) -> int:
        return self.end - self.start

    def word_count(self) -> int:
        return len(_WORD_RE.findall(self.text))


def words(text: str) -> list[str]:
    """Alphabetic word tokens, lowercase-preserving."""
    return _WORD_RE.findall(text)


def tokens(text: str) -> list[str]:
    """Whitespace-delimited tokens (used for length statistics)."""
    return _TOKEN_RE.findall(text)


def _looks_like_abbreviation(text: str, end: int) -> bool:
    prefix = text[max(0, end - 12) : end].rstrip(".")
    tail = re.split(r"[\s(]", prefix)[-1].lower()
    return tail in _ABBREVIATIONS


def split_sentences(text: str) -> list[Span]:
    """Split into sentences, keeping character offsets."""
    spans: list[Span] = []
    cursor = 0
    for match in _SENTENCE_END.finditer(text):
        end = match.end()
        boundary = match.start() + len(match.group(0).rstrip())
        if match.group(0).strip() and _looks_like_abbreviation(text, match.start() + 1):
            continue
        chunk = text[cursor:boundary]
        if chunk.strip():
            spans.append(Span(cursor, boundary, chunk.strip()))
        cursor = end
    tail = text[cursor:]
    if tail.strip():
        spans.append(Span(cursor, len(text), tail.strip()))
    return spans


def split_paragraphs(text: str) -> list[Span]:
    spans: list[Span] = []
    cursor = 0
    for match in re.finditer(r"\n\s*\n", text):
        chunk = text[cursor : match.start()]
        if chunk.strip():
            spans.append(Span(cursor, match.start(), chunk.strip()))
        cursor = match.end()
    tail = text[cursor:]
    if tail.strip():
        spans.append(Span(cursor, len(text), tail.strip()))
    return spans


def sliding_windows(
    text: str,
    target_words: int = 120,
    overlap_words: int = 30,
    min_words: int = 25,
) -> list[Span]:
    """Group sentences into overlapping windows of roughly ``target_words``.

    Windows follow sentence boundaries so that per-segment statistics stay
    meaningful; a window shorter than ``min_words`` is merged into its
    predecessor instead of being scored on its own.
    """
    if overlap_words >= target_words:
        raise ValueError("overlap_words must be smaller than target_words")

    sentences = split_sentences(text)
    if not sentences:
        return []

    windows: list[Span] = []
    index = 0
    while index < len(sentences):
        count = 0
        cursor = index
        while cursor < len(sentences) and count < target_words:
            count += sentences[cursor].word_count()
            cursor += 1
        start = sentences[index].start
        end = sentences[cursor - 1].end
        windows.append(Span(start, end, text[start:end].strip()))
        if cursor >= len(sentences):
            break
        # Step back far enough to create the requested overlap.
        back = 0
        step = cursor
        while step - 1 > index and back < overlap_words:
            back += sentences[step - 1].word_count()
            step -= 1
        index = max(step, index + 1)

    merged = _merge_short_tail(windows, text, min_words)
    return merged


def _merge_short_tail(windows: Sequence[Span], text: str, min_words: int) -> list[Span]:
    result = list(windows)
    if len(result) >= 2 and result[-1].word_count() < min_words:
        last = result.pop()
        previous = result.pop()
        start, end = previous.start, max(previous.end, last.end)
        result.append(Span(start, end, text[start:end].strip()))
    return result


__all__ = [
    "Span",
    "split_paragraphs",
    "split_sentences",
    "sliding_windows",
    "tokens",
    "words",
]
