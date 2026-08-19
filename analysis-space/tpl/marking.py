"""Embed a traceable mark in a document, one distinct copy per recipient.

This is the other half of the tool. Detection tells you a document is marked;
this puts the mark there in the first place, which is what makes leak tracing
possible: send five people five copies that read identically, and when one
surfaces you know which copy it was.

Three carriers are offered, all of which the detector already decodes:

``tag_characters``
    ``U+E0000 + n`` for ASCII ``n``. One codepoint per character, renders as
    nothing anywhere, survives copy-paste between most editors. The default.
``variation_selectors``
    One codepoint per *byte*, so any UTF-8 payload fits, including non-ASCII
    recipient names.
``zero_width_binary``
    Eight codepoints per byte. Bulky, but built only from the four common
    zero-width characters, which some pipelines pass through when they strip
    the more exotic blocks.

Carriers are spread across the document rather than appended in a block.
Appending is trivially defeated by deleting the last line, and a quoted excerpt
from the middle would carry nothing. Spreading means a partial document still
yields a partial mark, and repeating the payload means a quoted paragraph
usually still yields a whole one.

Nothing here is secret. Anyone who runs this tool on a marked document reads
the payload straight out, and the sanitiser in `tpl.sanitize` removes it
completely. This traces honest recipients; it does not withstand an adversary
who knows the technique.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .preprocessing import (
    decode_payloads,
    encode_tag_characters,
    encode_variation_selectors,
    encode_zero_width_binary,
)

CHANNELS = ("tag_characters", "variation_selectors", "zero_width_binary")

#: Separator between repeated copies, so a decoded mark reads as
#: ``id:42|id:42|`` rather than an ambiguous ``id:42id:42``.
SEPARATOR = "|"

#: Sentence-ish boundaries. Marks sit after punctuation, where an invisible
#: character is least likely to be disturbed by reflowing or reformatting.
_BOUNDARY = re.compile(r"(?<=[.!?])\s+")

_ENCODERS = {
    "tag_characters": encode_tag_characters,
    "variation_selectors": encode_variation_selectors,
    "zero_width_binary": encode_zero_width_binary,
}


class MarkingError(ValueError):
    """The document or the payload cannot carry the requested mark."""


@dataclass(frozen=True)
class MarkedCopy:
    recipient: str
    payload: str
    text: str
    channel: str
    carrier_chars: int
    copies_embedded: int
    verified: bool

    def as_dict(self) -> dict[str, object]:
        return {
            "recipient": self.recipient,
            "payload": self.payload,
            "text": self.text,
            "channel": self.channel,
            "carrier_chars": self.carrier_chars,
            "copies_embedded": self.copies_embedded,
            "verified": self.verified,
        }


def _insertion_points(text: str, wanted: int) -> list[int]:
    """Evenly spaced sentence boundaries, falling back to the end of the text."""
    boundaries = [m.end() for m in _BOUNDARY.finditer(text)]
    if not boundaries or wanted <= 0:
        return [len(text)]
    if wanted >= len(boundaries):
        return boundaries
    step = len(boundaries) / wanted
    chosen = {boundaries[min(int(i * step), len(boundaries) - 1)] for i in range(wanted)}
    return sorted(chosen)


def mark(
    text: str,
    payload: str,
    *,
    channel: str = "tag_characters",
    repeat: int = 2,
    recipient: str = "",
) -> MarkedCopy:
    """Return ``text`` carrying ``payload`` invisibly, and check it decodes back.

    The result is verified by running the document through the same decoders the
    detector uses. A mark that cannot be read back is worse than no mark, so a
    failure raises rather than returning a copy that looks fine.
    """
    if channel not in CHANNELS:
        raise MarkingError(f"unknown channel: {channel!r}")
    if not payload.strip():
        raise MarkingError("payload must not be empty")
    if repeat < 1:
        raise MarkingError("repeat must be at least 1")
    if channel == "tag_characters" and any(not 0x20 <= ord(c) <= 0x7E for c in payload):
        raise MarkingError(
            "tag_characters carries printable ASCII only; use variation_selectors "
            "for a payload with accented or non-Latin characters"
        )

    encode = _ENCODERS[channel]
    block = encode(payload + SEPARATOR)

    points = _insertion_points(text, repeat)
    out: list[str] = []
    previous = 0
    for point in points:
        out.append(text[previous:point])
        out.append(block)
        previous = point
    out.append(text[previous:])
    marked = "".join(out)

    recovered = [p.text for p in decode_payloads(marked)]
    expected = payload + SEPARATOR
    verified = any(expected in candidate for candidate in recovered)
    if not verified:
        raise MarkingError(
            f"the mark did not decode back out of the document via {channel}; "
            "refusing to return a copy that cannot be traced"
        )

    return MarkedCopy(
        recipient=recipient,
        payload=payload,
        text=marked,
        channel=channel,
        carrier_chars=len(marked) - len(text),
        copies_embedded=len(points),
        verified=True,
    )


def mark_for_recipients(
    text: str,
    recipients: list[str],
    *,
    template: str = "{recipient}",
    channel: str = "tag_characters",
    repeat: int = 2,
) -> list[MarkedCopy]:
    """One copy per recipient, each carrying a payload built from ``template``.

    ``template`` is formatted with ``recipient`` and ``index``, so
    ``"WF-{index:03d}"`` produces opaque ids when the recipient's name should
    not be readable inside the document itself.
    """
    if not recipients:
        raise MarkingError("at least one recipient is required")
    if len(set(recipients)) != len(recipients):
        raise MarkingError("recipients must be distinct, otherwise copies cannot be told apart")

    copies: list[MarkedCopy] = []
    for index, recipient in enumerate(recipients, start=1):
        try:
            payload = template.format(recipient=recipient, index=index)
        except (KeyError, IndexError, ValueError) as exc:
            raise MarkingError(
                f"template {template!r} uses a placeholder other than "
                "{recipient} or {index}"
            ) from exc
        copies.append(
            mark(text, payload, channel=channel, repeat=repeat, recipient=recipient)
        )

    texts = {copy.text for copy in copies}
    if len(texts) != len(copies):
        raise MarkingError("two recipients produced identical documents; marks are not distinct")
    return copies


__all__ = ["mark", "mark_for_recipients", "MarkedCopy", "MarkingError", "CHANNELS"]
