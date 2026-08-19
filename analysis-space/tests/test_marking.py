from __future__ import annotations

import pytest

from tpl.marking import CHANNELS, MarkingError, mark, mark_for_recipients
from tpl.preprocessing import decode_payloads
from tpl.sanitize import sanitize

DOC = (
    "Umowa o zachowaniu poufnosci. Strony zobowiazuja sie do nieujawniania informacji. "
    "Naruszenie skutkuje kara umowna. Umowa wchodzi w zycie z dniem podpisania. "
    "Zalaczniki stanowia integralna czesc niniejszej umowy."
)


def _recovered(text: str) -> list[str]:
    return [p.text for p in decode_payloads(text)]


class TestRoundTrip:
    """A mark that cannot be read back is worse than no mark at all."""

    @pytest.mark.parametrize("channel", CHANNELS)
    def test_every_channel_decodes_back(self, channel):
        copy = mark(DOC, "id:WF-007", channel=channel)
        assert copy.verified
        assert any("id:WF-007" in value for value in _recovered(copy.text))

    def test_the_visible_text_is_unchanged(self):
        copy = mark(DOC, "id:WF-007")
        assert sanitize(copy.text, level="aggressive").text == DOC

    def test_marking_refuses_a_payload_it_cannot_carry(self):
        with pytest.raises(MarkingError, match="printable ASCII only"):
            mark(DOC, "wlasciciel:Zażółć", channel="tag_characters")

    def test_a_non_ascii_payload_fits_the_byte_channel(self):
        copy = mark(DOC, "wlasciciel:Zazolc", channel="variation_selectors")
        assert any("Zazolc" in value for value in _recovered(copy.text))

    @pytest.mark.parametrize("bad", ["", "   "])
    def test_empty_payloads_are_rejected(self, bad):
        with pytest.raises(MarkingError, match="must not be empty"):
            mark(DOC, bad)

    def test_unknown_channel_is_rejected(self):
        with pytest.raises(MarkingError, match="unknown channel"):
            mark(DOC, "x", channel="steganography")


class TestDistribution:
    """Appending the mark in one block is defeated by deleting the last line."""

    def test_carriers_are_not_all_at_the_end(self):
        copy = mark(DOC, "id:WF-007", repeat=3)
        offsets = decode_payloads(copy.text)[0].offsets
        assert min(offsets) < len(copy.text) * 0.5

    def test_an_excerpt_still_carries_the_mark(self):
        copy = mark(DOC, "id:WF-007", repeat=3)
        middle = copy.text[len(copy.text) // 4 : 3 * len(copy.text) // 4]
        assert any("id:WF-007" in value for value in _recovered(middle))

    def test_repeat_must_be_positive(self):
        with pytest.raises(MarkingError, match="repeat must be at least 1"):
            mark(DOC, "x", repeat=0)


class TestRecipients:
    def test_each_recipient_gets_a_distinct_document(self):
        copies = mark_for_recipients(DOC, ["Jan", "Anna", "Piotr"], template="WF-{index:03d}")
        assert len({c.text for c in copies}) == 3
        assert [c.payload for c in copies] == ["WF-001", "WF-002", "WF-003"]

    def test_the_copies_read_identically(self):
        copies = mark_for_recipients(DOC, ["Jan", "Anna"])
        assert len({sanitize(c.text, level="aggressive").text for c in copies}) == 1

    def test_each_copy_names_only_its_own_recipient(self):
        copies = mark_for_recipients(DOC, ["Jan", "Anna"])
        for copy in copies:
            recovered = " ".join(_recovered(copy.text))
            assert copy.recipient in recovered
            for other in copies:
                if other.recipient != copy.recipient:
                    assert other.recipient not in recovered

    def test_duplicate_recipients_are_rejected(self):
        with pytest.raises(MarkingError, match="must be distinct"):
            mark_for_recipients(DOC, ["Jan", "Jan"])

    def test_empty_recipient_list_is_rejected(self):
        with pytest.raises(MarkingError, match="at least one recipient"):
            mark_for_recipients(DOC, [])

    def test_a_bad_template_is_reported_clearly(self):
        with pytest.raises(MarkingError, match="placeholder"):
            mark_for_recipients(DOC, ["Jan"], template="{department}")


class TestTheMarkIsNotPrivileged:
    """The sanitiser must strip our own marks as readily as anyone else's."""

    def test_sanitising_removes_a_mark_this_module_created(self):
        copy = mark(DOC, "id:WF-007")
        assert _recovered(sanitize(copy.text, level="safe").text) == []
