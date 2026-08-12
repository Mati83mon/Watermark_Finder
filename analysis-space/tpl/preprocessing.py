"""Text normalisation and covert-channel extraction.

The functions here are deliberately side-effect free and operate on ``str``
only, so they can be unit tested without any model or network dependency.

Three families of hidden channels are decoded:

``tag characters``
    ``U+E0000..U+E007F``. ``U+E0000 + n`` maps to ASCII codepoint ``n``; the
    block was designed for language tags and is invisible in every renderer,
    which makes it the simplest way to staple a payload onto a message.

``variation selectors``
    Byte ``b`` is encoded as ``U+FE00 + b`` for ``b < 16`` and
    ``U+E0100 + (b - 16)`` otherwise, giving a full 256-value alphabet that can
    hide arbitrary UTF-8 behind a single visible character.

``zero-width binary``
    Two zero-width characters are used as ``0`` and ``1`` and the bit string is
    read back in groups of eight. Several tools exist with different symbol
    assignments, so every plausible pairing is attempted and the candidate with
    the highest printable ratio wins.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass, field

from .unicode_tables import (
    CAT_TAG,
    CAT_VARIATION_SELECTOR,
    HOMOGLYPHS,
    INVISIBLE_CATEGORIES,
    classify_codepoint,
    iter_suspicious,
)

CONTEXT_RADIUS = 24


@dataclass(frozen=True)
class CharHit:
    """A single suspicious character found in the input."""

    offset: int
    codepoint: int
    category: str
    name: str
    context: str

    @property
    def label(self) -> str:
        return f"U+{self.codepoint:04X} {self.name}"


@dataclass(frozen=True)
class HomoglyphHit:
    offset: int
    char: str
    latin: str
    script: str
    word: str


@dataclass(frozen=True)
class DecodedPayload:
    """A payload recovered from one of the covert channels."""

    channel: str
    text: str
    byte_length: int
    printable_ratio: float
    offsets: tuple[int, ...]
    note: str = ""


@dataclass
class PreprocessResult:
    original: str
    normalized: str
    #: Text with every invisible character removed - what the linguistic
    #: analysis actually runs on.
    cleaned: str
    char_hits: list[CharHit] = field(default_factory=list)
    homoglyphs: list[HomoglyphHit] = field(default_factory=list)
    payloads: list[DecodedPayload] = field(default_factory=list)
    scripts: dict[str, int] = field(default_factory=dict)
    sha256: str = ""

    @property
    def invisible_hits(self) -> list[CharHit]:
        return [h for h in self.char_hits if h.category in INVISIBLE_CATEGORIES]


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _context(text: str, offset: int) -> str:
    start = max(0, offset - CONTEXT_RADIUS)
    end = min(len(text), offset + CONTEXT_RADIUS + 1)
    snippet = text[start:offset] + "‸" + text[offset + 1 : end]
    return strip_invisible(snippet).replace("\n", " ")


def strip_invisible(text: str) -> str:
    """Remove every character that belongs to an invisible category."""
    out: list[str] = []
    for char in text:
        hit = classify_codepoint(ord(char))
        if hit is not None and hit[0] in INVISIBLE_CATEGORIES:
            continue
        out.append(char)
    return "".join(out)


def scan_characters(text: str) -> list[CharHit]:
    return [
        CharHit(offset, cp, category, name, _context(text, offset))
        for offset, cp, category, name in iter_suspicious(text)
    ]


def script_of(char: str) -> str:
    """Coarse script name derived from the Unicode character name."""
    try:
        name = unicodedata.name(char)
    except ValueError:
        return "UNKNOWN"
    for script in (
        "CYRILLIC",
        "GREEK",
        "ARMENIAN",
        "HEBREW",
        "ARABIC",
        "CHEROKEE",
        "FULLWIDTH",
        "LATIN",
    ):
        if name.startswith(script) or f" {script} " in f" {name} ":
            return script
    if name.startswith("CJK"):
        return "CJK"
    return "OTHER"


_WORD_RE = re.compile(r"\w+", re.UNICODE)


def detect_homoglyphs(text: str) -> list[HomoglyphHit]:
    """Find non-Latin characters that visually mimic Latin letters.

    Only characters sitting inside a word that is otherwise Latin are reported;
    a fully Cyrillic or Greek word is legitimate text, not a substitution.
    """
    hits: list[HomoglyphHit] = []
    for match in _WORD_RE.finditer(text):
        word = match.group(0)
        if len(word) < 2:
            continue
        scripts = {script_of(ch) for ch in word if ch.isalpha()}
        if "LATIN" not in scripts:
            continue
        for index, char in enumerate(word):
            latin = HOMOGLYPHS.get(char)
            if latin is None:
                continue
            hits.append(
                HomoglyphHit(
                    offset=match.start() + index,
                    char=char,
                    latin=latin,
                    script=script_of(char),
                    word=word,
                )
            )
    return hits


def script_profile(text: str) -> dict[str, int]:
    profile: dict[str, int] = {}
    for char in text:
        if not char.isalpha():
            continue
        script = script_of(char)
        profile[script] = profile.get(script, 0) + 1
    return profile


# --------------------------------------------------------------------------
# Payload decoders
# --------------------------------------------------------------------------
def _printable_ratio(value: str) -> float:
    if not value:
        return 0.0
    printable = sum(1 for ch in value if ch.isprintable() or ch in "\n\t")
    return printable / len(value)


def _finalize(
    channel: str,
    data: bytes,
    offsets: Sequence[int],
    note: str = "",
    min_length: int = 2,
) -> DecodedPayload | None:
    if len(data) < min_length:
        return None
    try:
        decoded = data.decode("utf-8")
    except UnicodeDecodeError:
        decoded = data.decode("latin-1", errors="replace")
        note = (note + " (not valid UTF-8, shown as Latin-1)").strip()
    ratio = _printable_ratio(decoded)
    if ratio < 0.8:
        return None
    return DecodedPayload(
        channel=channel,
        text=decoded,
        byte_length=len(data),
        printable_ratio=ratio,
        offsets=tuple(offsets),
        note=note,
    )


def decode_tag_characters(text: str) -> DecodedPayload | None:
    """Decode a ``U+E0000`` tag-character payload, if one is present."""
    chars: list[int] = []
    offsets: list[int] = []
    for offset, char in enumerate(text):
        cp = ord(char)
        if 0xE0000 <= cp <= 0xE007F:
            offsets.append(offset)
            ascii_cp = cp - 0xE0000
            if 0x20 <= ascii_cp <= 0x7E:
                chars.append(ascii_cp)
    if not offsets:
        return None
    return _finalize(
        "tag_characters",
        bytes(chars),
        offsets,
        note="Unicode tag block (U+E0000-U+E007F)",
    )


def decode_variation_selectors(text: str) -> DecodedPayload | None:
    """Decode a byte stream hidden in variation selectors."""
    data: list[int] = []
    offsets: list[int] = []
    for offset, char in enumerate(text):
        cp = ord(char)
        if 0xFE00 <= cp <= 0xFE0F:
            data.append(cp - 0xFE00)
            offsets.append(offset)
        elif 0xE0100 <= cp <= 0xE01EF:
            data.append(cp - 0xE0100 + 16)
            offsets.append(offset)
    if not offsets:
        return None
    return _finalize(
        "variation_selectors",
        bytes(data),
        offsets,
        note="Variation selector byte encoding (VS1-VS256)",
    )


#: Symbol pairs used by public zero-width steganography tools, as (zero, one).
_ZERO_WIDTH_ALPHABETS: tuple[tuple[str, str], ...] = (
    ("​", "‌"),
    ("‌", "​"),
    ("​", "‍"),
    ("‍", "​"),
    ("‌", "‍"),
    ("⁠", "​"),
)


def decode_zero_width_binary(text: str) -> DecodedPayload | None:
    """Try to read a binary message encoded with zero-width characters."""
    best: DecodedPayload | None = None
    for zero, one in _ZERO_WIDTH_ALPHABETS:
        bits: list[str] = []
        offsets: list[int] = []
        for offset, char in enumerate(text):
            if char == zero:
                bits.append("0")
                offsets.append(offset)
            elif char == one:
                bits.append("1")
                offsets.append(offset)
        if len(bits) < 16:
            continue
        usable = len(bits) - (len(bits) % 8)
        data = bytes(int("".join(bits[i : i + 8]), 2) for i in range(0, usable, 8))
        candidate = _finalize(
            "zero_width_binary",
            data,
            offsets[:usable],
            note=f"8-bit groups, 0=U+{ord(zero):04X} 1=U+{ord(one):04X}",
        )
        if candidate is None:
            continue
        if best is None or candidate.printable_ratio > best.printable_ratio:
            best = candidate
    return best


def decode_payloads(text: str) -> list[DecodedPayload]:
    """Run every decoder and return the payloads that produced sane output."""
    payloads = []
    for decoder in (
        decode_tag_characters,
        decode_variation_selectors,
        decode_zero_width_binary,
    ):
        payload = decoder(text)
        if payload is not None:
            payloads.append(payload)
    return payloads


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------
def normalize_whitespace(text: str) -> str:
    """Convert exotic spaces to U+0020 and normalise line endings."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    out: list[str] = []
    for char in text:
        hit = classify_codepoint(ord(char))
        if hit is not None and hit[0] == "exotic_space":
            out.append(" ")
        else:
            out.append(char)
    return "".join(out)


def preprocess(text: str) -> PreprocessResult:
    """Full preprocessing pass over a raw input document."""
    char_hits = scan_characters(text)
    payloads = decode_payloads(text)
    normalized = unicodedata.normalize("NFC", normalize_whitespace(text))
    cleaned = strip_invisible(normalized)
    return PreprocessResult(
        original=text,
        normalized=normalized,
        cleaned=cleaned,
        char_hits=char_hits,
        homoglyphs=detect_homoglyphs(text),
        payloads=payloads,
        scripts=script_profile(cleaned),
        sha256=sha256_hex(text),
    )


def encode_tag_characters(payload: str) -> str:
    """Inverse of :func:`decode_tag_characters` - used by tests and fixtures."""
    return "".join(chr(0xE0000 + ord(ch)) for ch in payload if 0x20 <= ord(ch) <= 0x7E)


def encode_variation_selectors(payload: str) -> str:
    """Inverse of :func:`decode_variation_selectors`."""
    out: list[str] = []
    for byte in payload.encode("utf-8"):
        out.append(chr(0xFE00 + byte) if byte < 16 else chr(0xE0100 + byte - 16))
    return "".join(out)


def encode_zero_width_binary(payload: str, zero: str = "​", one: str = "‌") -> str:
    """Inverse of :func:`decode_zero_width_binary`."""
    bits = "".join(f"{byte:08b}" for byte in payload.encode("utf-8"))
    return "".join(zero if bit == "0" else one for bit in bits)


__all__ = [
    "CharHit",
    "DecodedPayload",
    "HomoglyphHit",
    "PreprocessResult",
    "CAT_TAG",
    "CAT_VARIATION_SELECTOR",
    "decode_payloads",
    "decode_tag_characters",
    "decode_variation_selectors",
    "decode_zero_width_binary",
    "detect_homoglyphs",
    "encode_tag_characters",
    "encode_variation_selectors",
    "encode_zero_width_binary",
    "normalize_whitespace",
    "preprocess",
    "scan_characters",
    "script_profile",
    "sha256_hex",
    "strip_invisible",
]
