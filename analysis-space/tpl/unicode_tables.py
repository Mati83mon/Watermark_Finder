"""Static Unicode tables used by the preprocessing and watermark modules.

Everything here is data, not logic: character classes that are relevant when
looking for hidden channels in text (zero-width characters, bidi controls,
variation selectors, tag characters, exotic spaces) and confusable letters used
for homoglyph substitution.

Codepoint names follow the Unicode Character Database so that reports can quote
them verbatim.
"""

from __future__ import annotations

from collections.abc import Iterable

# --------------------------------------------------------------------------
# Category names used across the codebase.
# --------------------------------------------------------------------------
CAT_ZERO_WIDTH = "zero_width"
CAT_BIDI = "bidi_control"
CAT_VARIATION_SELECTOR = "variation_selector"
CAT_TAG = "tag_char"
CAT_EXOTIC_SPACE = "exotic_space"
CAT_FORMAT = "format_control"

# --------------------------------------------------------------------------
# Individually enumerated characters.
# --------------------------------------------------------------------------
ZERO_WIDTH: dict[int, str] = {
    0x200B: "ZERO WIDTH SPACE",
    0x200C: "ZERO WIDTH NON-JOINER",
    0x200D: "ZERO WIDTH JOINER",
    0x2060: "WORD JOINER",
    0x2061: "FUNCTION APPLICATION",
    0x2062: "INVISIBLE TIMES",
    0x2063: "INVISIBLE SEPARATOR",
    0x2064: "INVISIBLE PLUS",
    0xFEFF: "ZERO WIDTH NO-BREAK SPACE (BOM)",
    0x180E: "MONGOLIAN VOWEL SEPARATOR",
}

BIDI_CONTROLS: dict[int, str] = {
    0x200E: "LEFT-TO-RIGHT MARK",
    0x200F: "RIGHT-TO-LEFT MARK",
    0x202A: "LEFT-TO-RIGHT EMBEDDING",
    0x202B: "RIGHT-TO-LEFT EMBEDDING",
    0x202C: "POP DIRECTIONAL FORMATTING",
    0x202D: "LEFT-TO-RIGHT OVERRIDE",
    0x202E: "RIGHT-TO-LEFT OVERRIDE",
    0x2066: "LEFT-TO-RIGHT ISOLATE",
    0x2067: "RIGHT-TO-LEFT ISOLATE",
    0x2068: "FIRST STRONG ISOLATE",
    0x2069: "POP DIRECTIONAL ISOLATE",
}

FORMAT_CONTROLS: dict[int, str] = {
    0x00AD: "SOFT HYPHEN",
    0x034F: "COMBINING GRAPHEME JOINER",
    0x115F: "HANGUL CHOSEONG FILLER",
    0x1160: "HANGUL JUNGSEONG FILLER",
    0x3164: "HANGUL FILLER",
    0xFFA0: "HALFWIDTH HANGUL FILLER",
}

EXOTIC_SPACES: dict[int, str] = {
    0x00A0: "NO-BREAK SPACE",
    0x2000: "EN QUAD",
    0x2001: "EM QUAD",
    0x2002: "EN SPACE",
    0x2003: "EM SPACE",
    0x2004: "THREE-PER-EM SPACE",
    0x2005: "FOUR-PER-EM SPACE",
    0x2006: "SIX-PER-EM SPACE",
    0x2007: "FIGURE SPACE",
    0x2008: "PUNCTUATION SPACE",
    0x2009: "THIN SPACE",
    0x200A: "HAIR SPACE",
    0x202F: "NARROW NO-BREAK SPACE",
    0x205F: "MEDIUM MATHEMATICAL SPACE",
    0x3000: "IDEOGRAPHIC SPACE",
}

# --------------------------------------------------------------------------
# Ranges (start, end inclusive, category, name template).
# --------------------------------------------------------------------------
RANGES: tuple[tuple[int, int, str, str], ...] = (
    (0xFE00, 0xFE0F, CAT_VARIATION_SELECTOR, "VARIATION SELECTOR-{n}"),
    (0xE0100, 0xE01EF, CAT_VARIATION_SELECTOR, "VARIATION SELECTOR-{n}"),
    (0xE0000, 0xE007F, CAT_TAG, "TAG CHARACTER U+{cp:04X}"),
)

_SINGLE_TABLES: tuple[tuple[dict[int, str], str], ...] = (
    (ZERO_WIDTH, CAT_ZERO_WIDTH),
    (BIDI_CONTROLS, CAT_BIDI),
    (FORMAT_CONTROLS, CAT_FORMAT),
    (EXOTIC_SPACES, CAT_EXOTIC_SPACE),
)


def classify_codepoint(cp: int) -> tuple[str, str] | None:
    """Return ``(category, unicode_name)`` for a suspicious codepoint.

    Returns ``None`` when the codepoint is an ordinary visible character.
    """
    for table, category in _SINGLE_TABLES:
        name = table.get(cp)
        if name is not None:
            return category, name

    for start, end, category, template in RANGES:
        if start <= cp <= end:
            if category == CAT_VARIATION_SELECTOR:
                index = cp - 0xFE00 + 1 if cp <= 0xFE0F else cp - 0xE0100 + 17
                return category, template.format(n=index)
            return category, template.format(cp=cp)
    return None


#: Categories that never render and therefore make good covert channels.
INVISIBLE_CATEGORIES = frozenset(
    {CAT_ZERO_WIDTH, CAT_BIDI, CAT_VARIATION_SELECTOR, CAT_TAG, CAT_FORMAT}
)

# --------------------------------------------------------------------------
# Homoglyphs: non-Latin characters that render like Latin ones.
# --------------------------------------------------------------------------
HOMOGLYPHS: dict[str, str] = {
    # Cyrillic -> Latin
    "а": "a",
    "е": "e",
    "о": "o",
    "р": "p",
    "с": "c",
    "у": "y",
    "х": "x",
    "і": "i",
    "ј": "j",
    "һ": "h",
    "А": "A",
    "В": "B",
    "Е": "E",
    "К": "K",
    "М": "M",
    "Н": "H",
    "О": "O",
    "Р": "P",
    "С": "C",
    "Т": "T",
    "У": "Y",
    "Х": "X",
    "Ѕ": "S",
    "І": "I",
    "Ј": "J",
    # Greek -> Latin
    "ο": "o",
    "α": "a",
    "β": "b",
    "ε": "e",
    "ι": "i",
    "κ": "k",
    "ν": "v",
    "ρ": "p",
    "τ": "t",
    "χ": "x",
    "Α": "A",
    "Β": "B",
    "Ε": "E",
    "Ζ": "Z",
    "Η": "H",
    "Ι": "I",
    "Κ": "K",
    "Μ": "M",
    "Ν": "N",
    "Ο": "O",
    "Ρ": "P",
    "Τ": "T",
    "Υ": "Y",
    "Χ": "X",
    # Fullwidth / mathematical lookalikes
    "ａ": "a",
    "ｅ": "e",
    "ｏ": "o",
    # Armenian / Cherokee lookalikes seen in the wild
    "օ": "o",
    "Ꭰ": "D",
    "Ꮐ": "G",
}

#: Punctuation that a keyboard rarely produces but text generators emit.
TYPOGRAPHIC_PUNCTUATION: dict[int, str] = {
    0x2018: "LEFT SINGLE QUOTATION MARK",
    0x2019: "RIGHT SINGLE QUOTATION MARK",
    0x201C: "LEFT DOUBLE QUOTATION MARK",
    0x201D: "RIGHT DOUBLE QUOTATION MARK",
    0x2013: "EN DASH",
    0x2014: "EM DASH",
    0x2026: "HORIZONTAL ELLIPSIS",
    0x2011: "NON-BREAKING HYPHEN",
    0x2032: "PRIME",
    0x00A0: "NO-BREAK SPACE",
}


#: Variation selectors 15 and 16 choose text or emoji presentation for the
#: character before them. ``U+26A0`` renders as a plain glyph; ``U+26A0 U+FE0F``
#: renders as the warning emoji. They are ordinary text, not a covert channel.
VS_TEXT = 0xFE0E
VS_EMOJI = 0xFE0F


def _is_pictographic(cp: int) -> bool:
    return (
        0x1F000 <= cp <= 0x1FAFF
        or 0x2600 <= cp <= 0x27BF
        or 0x2190 <= cp <= 0x21FF
        or 0x2B00 <= cp <= 0x2BFF
        or 0x3030 <= cp <= 0x303D
        or cp in (0x00A9, 0x00AE, 0x203C, 0x2049, 0x2122, 0x2139)
    )


def is_presentation_selector(text: str, offset: int) -> bool:
    """True when the selector at ``offset`` is doing presentation, not hiding data.

    Three conditions, all required. It has to be VS15 or VS16 - the other
    selectors carry no presentation meaning. It has to sit directly after a
    pictographic character, which is the only place presentation applies. And it
    has to be alone: one selector styles the glyph before it, whereas a run of
    them after a single base is how a payload is written.

    Without this, any document containing a warning sign or a tick was reported
    as carrying a watermark, while `tpl.sanitize` - correctly - refused to
    remove the same characters. Two parts of the codebase cannot disagree about
    what a byte means.
    """
    if offset >= len(text) or ord(text[offset]) not in (VS_TEXT, VS_EMOJI):
        return False
    if offset == 0 or not _is_pictographic(ord(text[offset - 1])):
        return False
    following = offset + 1
    return following >= len(text) or ord(text[following]) not in (VS_TEXT, VS_EMOJI)


def iter_suspicious(text: str) -> Iterable[tuple[int, int, str, str]]:
    """Yield ``(offset, codepoint, category, name)`` for every suspicious char."""
    for offset, char in enumerate(text):
        cp = ord(char)
        if cp < 0x00A0:  # fast path: plain ASCII and C1 controls are handled elsewhere
            continue
        if is_presentation_selector(text, offset):
            continue
        hit = classify_codepoint(cp)
        if hit is not None:
            yield offset, cp, hit[0], hit[1]
