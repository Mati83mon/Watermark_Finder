"""Remove covert-channel characters without damaging legitimate text.

`preprocessing.strip_invisible` exists already, but it is a blunt instrument
used internally before feature extraction, where a little collateral damage
costs nothing. Offered to a user as "clean my document" it silently corrupts
real text. Measured on the current implementation::

    family emoji   \U0001F468‍\U0001F469\U0001F467  ->  three separate people
    heart emoji    U+2764 U+FE0F                          ->  a dingbat glyph
    Persian        mi‍khaham                          ->  wrong word form
    Devanagari     conjunct with ZWJ                       ->  different ligature

Zero-width joiners are required by Arabic, Persian, Devanagari and their
relatives; variation selector 16 is what makes an emoji an emoji; the variation
selector supplement carries legitimate CJK ideographic variants. None of those
are watermarks, and stripping them is data loss.

So this module removes a character only when nothing in the document justifies
keeping it, reports every removal with its reason, and reports what it kept and
why. Two levels are offered:

``safe``
    Removes carriers that have no legitimate use in this document's scripts.
    Whatever a script genuinely needs is preserved.

``aggressive``
    Removes every invisible character. Guarantees no covert channel survives,
    at the risk of altering emoji and non-Latin text, so the result always
    carries the list of what it broke.

Homoglyph normalisation is separate and off by default: rewriting Cyrillic
``а`` to Latin ``a`` inside genuinely Russian prose is vandalism. When
enabled it uses `detect_homoglyphs`, which already reports only characters
sitting inside otherwise-Latin words.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field

from .preprocessing import detect_homoglyphs
from .unicode_tables import (
    CAT_BIDI,
    CAT_EXOTIC_SPACE,
    CAT_FORMAT,
    CAT_TAG,
    CAT_VARIATION_SELECTOR,
    CAT_ZERO_WIDTH,
    classify_codepoint,
)

#: Joiners that several writing systems need in ordinary words.
ZWJ = "‍"
ZWNJ = "‌"

#: Variation selectors that choose emoji or text presentation. Never carriers.
VS_TEXT = "︎"
VS_EMOJI = "️"

#: Scripts whose ordinary spelling uses ZWJ/ZWNJ. Checked against the Unicode
#: character name of the neighbouring character, which is enough here and needs
#: no dependency on a script-property table.
JOINING_SCRIPTS = (
    "ARABIC",
    "SYRIAC",
    "THAANA",
    "DEVANAGARI",
    "BENGALI",
    "GURMUKHI",
    "GUJARATI",
    "ORIYA",
    "TAMIL",
    "TELUGU",
    "KANNADA",
    "MALAYALAM",
    "SINHALA",
    "MYANMAR",
    "KHMER",
    "HEBREW",
)

#: Exotic spaces that a keyboard does not produce and that carry no meaning a
#: normal space cannot. NBSP is deliberately absent: it is real typography in
#: French and Polish, and removing it changes line breaking.
NBSP = " "
NARROW_NBSP = " "


@dataclass(frozen=True)
class Change:
    offset: int
    char: str
    codepoint: str
    name: str
    reason: str

    def as_dict(self) -> dict[str, object]:
        return {
            "offset": self.offset,
            "codepoint": self.codepoint,
            "name": self.name,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class Replacement:
    offset: int
    before: str
    after: str
    reason: str

    def as_dict(self) -> dict[str, object]:
        return {
            "offset": self.offset,
            "before": self.before,
            "after": self.after,
            "reason": self.reason,
        }


@dataclass
class SanitizeResult:
    text: str
    level: str
    removed: list[Change] = field(default_factory=list)
    replaced: list[Replacement] = field(default_factory=list)
    preserved: list[Change] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.removed or self.replaced)

    def as_dict(self) -> dict[str, object]:
        return {
            "text": self.text,
            "level": self.level,
            "changed": self.changed,
            "removed": [c.as_dict() for c in self.removed],
            "removed_total": len(self.removed),
            "replaced": [r.as_dict() for r in self.replaced],
            "replaced_total": len(self.replaced),
            "preserved": [c.as_dict() for c in self.preserved],
            "preserved_total": len(self.preserved),
            "warnings": self.warnings,
        }


def _name(char: str) -> str:
    try:
        return unicodedata.name(char)
    except ValueError:
        return "UNNAMED"


def _is_pictographic(char: str) -> bool:
    cp = ord(char)
    return (
        0x1F000 <= cp <= 0x1FAFF
        or 0x2600 <= cp <= 0x27BF
        or 0x2190 <= cp <= 0x21FF
        or cp in (0x00A9, 0x00AE, 0x203C, 0x2049)
    )


def _uses_joiners(char: str) -> bool:
    name = _name(char)
    return any(name.startswith(script) for script in JOINING_SCRIPTS)


def _neighbours(text: str, index: int) -> tuple[str | None, str | None]:
    before = text[index - 1] if index > 0 else None
    after = text[index + 1] if index + 1 < len(text) else None
    return before, after


def _joiner_is_load_bearing(text: str, index: int) -> bool:
    """True when this ZWJ/ZWNJ is doing real work rather than hiding a mark."""
    before, after = _neighbours(text, index)
    for side in (before, after):
        if side is None:
            continue
        if _is_pictographic(side) or _uses_joiners(side):
            return True
    return False


def _document_has_rtl(text: str) -> bool:
    return any(
        unicodedata.bidirectional(ch) in ("R", "AL", "AN") for ch in text
    )


def _document_has_cjk(text: str) -> bool:
    return any(_name(ch).startswith("CJK") for ch in text)


def sanitize(
    text: str,
    *,
    level: str = "safe",
    normalize_homoglyphs: bool = False,
) -> SanitizeResult:
    """Strip covert-channel characters from ``text``.

    ``level`` is ``safe`` or ``aggressive``. See the module docstring for what
    each guarantees. Every decision, including every character kept, is
    reported so the caller can show the user exactly what happened.
    """
    if level not in ("safe", "aggressive"):
        raise ValueError(f"unknown sanitize level: {level!r}")

    aggressive = level == "aggressive"
    has_rtl = _document_has_rtl(text)
    has_cjk = _document_has_cjk(text)

    out: list[str] = []
    removed: list[Change] = []
    preserved: list[Change] = []
    replaced: list[Replacement] = []

    for index, char in enumerate(text):
        classified = classify_codepoint(ord(char))
        if classified is None:
            out.append(char)
            continue

        category, name = classified
        keep_reason: str | None = None

        if not aggressive:
            if char in (ZWJ, ZWNJ) and _joiner_is_load_bearing(text, index):
                keep_reason = (
                    "joins an emoji sequence or a script that spells words with it"
                )
            elif char in (VS_TEXT, VS_EMOJI):
                keep_reason = "selects emoji or text presentation, not a carrier"
            elif category == CAT_VARIATION_SELECTOR and has_cjk:
                keep_reason = "may encode a CJK ideographic variant in this document"
            elif category == CAT_BIDI and has_rtl:
                keep_reason = "document contains right-to-left text that relies on it"
            elif char in (NBSP, NARROW_NBSP):
                keep_reason = "non-breaking space is ordinary typography"

        if keep_reason is not None:
            preserved.append(Change(index, char, f"U+{ord(char):04X}", name, keep_reason))
            out.append(char)
            continue

        if category == CAT_EXOTIC_SPACE:
            replaced.append(
                Replacement(index, f"U+{ord(char):04X}", "U+0020", "normalised to a plain space")
            )
            out.append(" ")
            continue

        reason = {
            CAT_TAG: "tag characters have no use in plain text and are a standard carrier",
            CAT_ZERO_WIDTH: "renders as nothing and carries no meaning here",
            CAT_VARIATION_SELECTOR: "variation selector with no glyph to vary",
            CAT_BIDI: "bidi control in a document with no right-to-left text",
            CAT_FORMAT: "invisible formatting control",
        }.get(category, "invisible character")
        if aggressive and category in (CAT_ZERO_WIDTH, CAT_VARIATION_SELECTOR, CAT_BIDI):
            reason = "removed unconditionally at the aggressive level"
        removed.append(Change(index, char, f"U+{ord(char):04X}", name, reason))

    cleaned = "".join(out)

    if normalize_homoglyphs:
        hits = detect_homoglyphs(cleaned)
        if hits:
            chars = list(cleaned)
            for hit in hits:
                chars[hit.offset] = hit.latin
                replaced.append(
                    Replacement(
                        hit.offset,
                        hit.char,
                        hit.latin,
                        f"{hit.script.title()} letter inside the Latin word {hit.word!r}",
                    )
                )
            cleaned = "".join(chars)

    warnings: list[str] = []
    if aggressive:
        broke = [c for c in removed if c.char in (ZWJ, ZWNJ, VS_EMOJI, VS_TEXT)]
        if broke:
            warnings.append(
                f"Aggressive level removed {len(broke)} joiner or presentation "
                "selector(s). Emoji sequences and non-Latin words may render "
                "differently. Use the safe level if the document is not plain English."
            )
    if preserved:
        warnings.append(
            f"{len(preserved)} invisible character(s) were kept because this "
            "document needs them. A watermark hidden in those positions would "
            "survive; the aggressive level removes them at the cost of breaking text."
        )

    return SanitizeResult(
        text=cleaned,
        level=level,
        removed=removed,
        replaced=replaced,
        preserved=preserved,
        warnings=warnings,
    )


__all__ = ["sanitize", "SanitizeResult", "Change", "Replacement"]
