from __future__ import annotations

import pytest

from tpl.preprocessing import (
    decode_payloads,
    decode_tag_characters,
    decode_variation_selectors,
    decode_zero_width_binary,
    detect_homoglyphs,
    encode_tag_characters,
    encode_variation_selectors,
    encode_zero_width_binary,
    normalize_whitespace,
    preprocess,
    scan_characters,
    strip_invisible,
)
from tpl.unicode_tables import CAT_TAG, CAT_VARIATION_SELECTOR, CAT_ZERO_WIDTH


def test_clean_text_has_no_hits():
    result = preprocess("A perfectly ordinary sentence, written by hand.")
    assert result.char_hits == []
    assert result.homoglyphs == []
    assert result.payloads == []
    assert result.cleaned == result.original


def test_scan_finds_zero_width_space():
    text = "hello​world"
    hits = scan_characters(text)
    assert len(hits) == 1
    assert hits[0].offset == 5
    assert hits[0].category == CAT_ZERO_WIDTH
    assert "ZERO WIDTH SPACE" in hits[0].name
    assert "‸" in hits[0].context


def test_scan_classifies_tag_and_variation_selectors():
    text = "x" + chr(0xE0041) + chr(0xFE0F)
    categories = {hit.category for hit in scan_characters(text)}
    assert categories == {CAT_TAG, CAT_VARIATION_SELECTOR}


@pytest.mark.parametrize("payload", ["watermark-42", "id:7f3a9c", "hello world"])
def test_tag_character_roundtrip(payload: str):
    text = "Visible text." + encode_tag_characters(payload)
    decoded = decode_tag_characters(text)
    assert decoded is not None
    assert decoded.text == payload
    assert decoded.channel == "tag_characters"
    assert decoded.byte_length == len(payload)


@pytest.mark.parametrize("payload", ["trace-id-99", "ĄĆĘ unicode", "x" * 40])
def test_variation_selector_roundtrip(payload: str):
    text = "Hello" + encode_variation_selectors(payload) + " world"
    decoded = decode_variation_selectors(text)
    assert decoded is not None
    assert decoded.text == payload


def test_zero_width_binary_roundtrip():
    payload = "secret"
    text = "Lorem ipsum " + encode_zero_width_binary(payload) + " dolor sit amet."
    decoded = decode_zero_width_binary(text)
    assert decoded is not None
    assert decoded.text == payload
    assert decoded.channel == "zero_width_binary"


def test_zero_width_binary_ignores_short_noise():
    # A single stray zero-width character is not a payload.
    assert decode_zero_width_binary("a​b") is None


def test_decoders_return_none_on_clean_text():
    text = "Nothing hidden in here at all."
    assert decode_tag_characters(text) is None
    assert decode_variation_selectors(text) is None
    assert decode_zero_width_binary(text) is None


def test_homoglyph_detection_flags_cyrillic_in_latin_word():
    text = "This is a pаssword field."  # Cyrillic а
    hits = detect_homoglyphs(text)
    assert len(hits) == 1
    assert hits[0].latin == "a"
    assert hits[0].script == "CYRILLIC"
    assert hits[0].word == "pаssword"


def test_homoglyph_detection_ignores_genuine_cyrillic_words():
    assert detect_homoglyphs("Это русский текст") == []


def test_strip_invisible_removes_only_invisibles():
    text = "a​b­c" + chr(0xE0041)
    assert strip_invisible(text) == "abc"


def test_normalize_whitespace_maps_exotic_spaces():
    text = "a b c\r\nd"
    assert normalize_whitespace(text) == "a b c\nd"


def test_preprocess_reports_scripts_and_hash():
    result = preprocess("Hello there")
    assert result.scripts == {"LATIN": 10}
    assert len(result.sha256) == 64


def test_preprocess_collects_multiple_payload_channels():
    text = "Report body." + encode_tag_characters("tag-1") + encode_variation_selectors("vs-2")
    result = preprocess(text)
    channels = {payload.channel for payload in result.payloads}
    assert channels == {"tag_characters", "variation_selectors"}
    assert len(result.invisible_hits) > 0


def test_plain_markers_do_not_become_a_fake_payload():
    """Zero-width characters used as markers are not a binary message.

    Found by a real test file: ZWSP dropped every ninth word and ZWJ every
    fourteenth read as bits and decoded to ``ÿÿÿ``, which the printable check
    happily accepted, so the app announced ``payload_recovered`` for a payload
    that never existed. Claiming a message that is not there is worse than
    reporting none.
    """
    marked, count = [], 0
    for char in "Analiza systemow autonomicznych wskazuje na kluczowe znaczenie modeli. " * 12:
        marked.append(char)
        if char == " ":
            count += 1
            if count % 9 == 0:
                marked.append("​")
            elif count % 14 == 0:
                marked.append("‍")
    text = "".join(marked)

    assert decode_zero_width_binary(text) is None
    # The markers are still a watermark - they simply do not decode.
    assert len(scan_characters(text)) >= 10


def test_control_characters_disqualify_a_payload():
    from tpl.preprocessing import _looks_like_a_message

    assert _looks_like_a_message("wm:demo-1") is True
    assert _looks_like_a_message("owner:Mateusz|id:001") is True
    assert _looks_like_a_message("ÿÿÿ") is False  # one repeated character
    assert _looks_like_a_message("JR\x91)JD") is False  # C1 control byte
    assert _looks_like_a_message("ab") is False  # too few distinct


def test_real_payloads_still_decode_after_the_stricter_check():
    for payload in ("wm:demo-1", "owner:Mateusz|release:2026-08-13", "trace 42"):
        text = "Ordinary looking prose." + encode_zero_width_binary(payload)
        decoded = decode_zero_width_binary(text)
        assert decoded is not None, payload
        assert decoded.text == payload


class TestEmojiPresentationIsNotAWatermark:
    """The scanner and the sanitiser cannot disagree about what a byte means.

    A model card containing `⚠️` was reported as `watermark suspected` at 60%
    on the strength of three U+FE0F codepoints, while `tpl.sanitize` looked at
    the same characters and refused to remove them because they are "emoji
    presentation, not a carrier". Both statements shipped in the same release.

    U+FE0F after a pictographic base is what makes ⚠️ an emoji rather than a
    dingbat. It is ordinary text and every document with a tick or a warning
    sign was being flagged for it.
    """

    def test_an_emoji_selector_is_not_reported(self):
        assert scan_characters("Uwaga ⚠️ koniec.") == []

    def test_a_document_of_emoji_stays_clean(self):
        assert scan_characters("✅ done ❤️ thanks ⚠️ careful") == []

    def test_a_selector_with_no_pictographic_base_is_still_reported(self):
        # Nothing to style: this is a carrier wearing a costume.
        assert scan_characters("plain text️ here") != []

    def test_a_run_of_selectors_after_an_emoji_is_still_a_payload(self):
        # The exemption covers one selector styling the glyph before it. A run
        # of them after a single base is how a payload is written, and must not
        # be able to hide behind the emoji rule.
        marked = "Uwaga ⚠" + encode_variation_selectors("hidden")
        assert decode_payloads(marked)[0].text == "hidden"

    def test_a_real_payload_is_untouched_by_the_exemption(self):
        marked = "Poufna umowa." + encode_variation_selectors("leak-42")
        assert decode_payloads(marked)[0].text == "leak-42"

    def test_the_scanner_and_the_sanitiser_now_agree(self):
        from tpl.sanitize import sanitize

        text = "⚠️ IMPORTANT ✅ done"
        assert scan_characters(text) == []
        assert sanitize(text, level="safe").text == text
