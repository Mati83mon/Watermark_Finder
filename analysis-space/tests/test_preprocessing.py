from __future__ import annotations

import pytest

from tpl.preprocessing import (
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
