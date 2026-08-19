from __future__ import annotations

import pytest

from tpl.preprocessing import (
    decode_payloads,
    encode_tag_characters,
    encode_variation_selectors,
    encode_zero_width_binary,
)
from tpl.sanitize import sanitize

FAMILY = "\U0001F468‍\U0001F469\U0001F467"
HEART = "❤️"
PERSIAN = "می‌خواهم"
DEVANAGARI = "क्‍ष"


class TestSafeLevelPreservesRealText:
    """The reason this module exists.

    `strip_invisible` turns the family emoji into three separate people, the
    heart into a dingbat, and the Persian word into a different one. A "clean
    my document" button that does that is data loss, not sanitisation.
    """

    @pytest.mark.parametrize(
        ("name", "text"),
        [
            ("family emoji", FAMILY),
            ("emoji presentation selector", HEART),
            ("Persian ZWNJ", PERSIAN),
            ("Devanagari ZWJ", DEVANAGARI),
        ],
    )
    def test_legitimate_joiners_survive(self, name, text):
        result = sanitize(text, level="safe")
        assert result.text == text, f"{name} was altered"
        assert result.removed == []
        assert result.preserved

    def test_preserving_is_reported_not_silent(self):
        result = sanitize(PERSIAN, level="safe")
        assert any("kept because this document needs them" in w for w in result.warnings)


class TestSafeLevelStillRemovesWatermarks:
    def test_tag_payload_is_destroyed(self):
        marked = "Confidential draft." + encode_tag_characters("owner:Jan|id:WF-007")
        result = sanitize(marked, level="safe")
        assert result.text == "Confidential draft."
        assert decode_payloads(result.text) == []

    def test_zero_width_binary_payload_is_destroyed(self):
        marked = "Report body" + encode_zero_width_binary("wm:demo")
        result = sanitize(marked, level="safe")
        assert result.text == "Report body"
        assert decode_payloads(result.text) == []

    def test_variation_selector_payload_is_destroyed(self):
        marked = "Report body" + encode_variation_selectors("leak-42")
        result = sanitize(marked, level="safe")
        assert decode_payloads(result.text) == []

    def test_clean_text_is_returned_untouched(self):
        text = "Zwykle zdanie bez zadnych sztuczek."
        result = sanitize(text, level="safe")
        assert result.text == text
        assert not result.changed


class TestTheHonestTradeoff:
    """A joiner that a script needs is also a place to hide a mark.

    Safe mode keeps it and says so; aggressive mode removes it and says what it
    may have broken. What must never happen is either choice being silent.
    """

    def setup_method(self):
        self.tricky = PERSIAN + "​​​"

    def test_safe_keeps_the_joiner_and_admits_the_gap(self):
        result = sanitize(self.tricky, level="safe")
        assert len(result.preserved) == 1
        assert "would survive" in " ".join(result.warnings)

    def test_aggressive_removes_everything_and_admits_the_damage(self):
        result = sanitize(self.tricky, level="aggressive")
        assert result.preserved == []
        assert "may render differently" in " ".join(result.warnings)

    def test_unknown_level_is_rejected(self):
        with pytest.raises(ValueError, match="unknown sanitize level"):
            sanitize("x", level="thorough")


class TestHomoglyphNormalisation:
    def test_off_by_default(self):
        text = "systеm"  # Cyrillic e inside a Latin word
        assert sanitize(text).text == text

    def test_rewrites_only_when_asked(self):
        text = "systеm"
        result = sanitize(text, normalize_homoglyphs=True)
        assert result.text == "system"
        assert result.replaced[0].before == "е"

    def test_genuinely_cyrillic_words_are_left_alone(self):
        text = "это русский текст"
        result = sanitize(text, normalize_homoglyphs=True)
        assert result.text == text
        assert result.replaced == []


class TestExoticSpaces:
    def test_normalised_to_a_plain_space(self):
        result = sanitize("a b")  # em space
        assert result.text == "a b"
        assert result.replaced[0].after == "U+0020"

    def test_non_breaking_space_is_typography_not_a_carrier(self):
        text = "10 km"
        assert sanitize(text).text == text
