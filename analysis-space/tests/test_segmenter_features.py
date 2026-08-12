from __future__ import annotations

from tpl.features import FEATURE_ORDER, detect_language, extract_features
from tpl.segmenter import sliding_windows, split_paragraphs, split_sentences, words


def test_split_sentences_offsets_map_back():
    text = "First one. Second one! Third one?"
    spans = split_sentences(text)
    assert len(spans) == 3
    for span in spans:
        assert text[span.start : span.end].strip() == span.text


def test_split_sentences_keeps_abbreviations_together():
    text = "We met dr. Kowalski yesterday. He was late."
    spans = split_sentences(text)
    assert len(spans) == 2
    assert "dr. Kowalski" in spans[0].text


def test_split_paragraphs():
    text = "Para one line one.\nStill para one.\n\nPara two."
    spans = split_paragraphs(text)
    assert len(spans) == 2
    assert spans[1].text == "Para two."


def test_sliding_windows_cover_document_in_order():
    text = " ".join(f"Sentence number {i} is here." for i in range(60))
    windows = sliding_windows(text, target_words=50, overlap_words=10)
    assert len(windows) > 1
    assert windows[0].start == 0
    assert windows[-1].end <= len(text)
    for previous, current in zip(windows, windows[1:], strict=False):
        assert current.start > previous.start
        assert current.start < previous.end  # overlap is real


def test_sliding_windows_short_text_is_single_window():
    windows = sliding_windows("Only one short sentence here.", target_words=120)
    assert len(windows) == 1


def test_words_ignores_punctuation_and_digits():
    assert words("Hello, world 42 times!") == ["Hello", "world", "times"]


def test_detect_language_english_and_polish(human_text, polish_text):
    assert detect_language(human_text).code == "en"
    assert detect_language(polish_text).code == "pl"


def test_detect_language_unknown_for_gibberish():
    assert detect_language("zzz qqq xxx vvv").code == "unknown"


def test_extract_features_returns_full_vector(human_text):
    features = extract_features(human_text)
    assert set(features.values) == set(FEATURE_ORDER)
    assert len(features.vector()) == len(FEATURE_ORDER)
    assert features.n_words > 100
    assert features.n_sentences > 5
    assert features.language == "en"


def test_ratio_features_stay_in_range(human_text, assistant_text, polish_text):
    for text in (human_text, assistant_text, polish_text):
        values = extract_features(text).values
        for name in (
            "mattr",
            "hapax_ratio",
            "curly_quote_ratio",
            "bullet_line_ratio",
            "long_word_ratio",
            "sentence_start_repetition",
        ):
            assert 0.0 <= values[name] <= 1.0, f"{name} out of range for sample"


def test_assistant_markers_are_higher_in_assistant_text(human_text, assistant_text):
    human = extract_features(human_text).values
    assistant = extract_features(assistant_text).values
    assert assistant["discourse_marker_rate"] > human["discourse_marker_rate"]
    assert assistant["assistant_lexicon_rate"] > human["assistant_lexicon_rate"]
    assert human["sentence_length_cv"] > assistant["sentence_length_cv"]


def test_contraction_rate_is_english_only(polish_text):
    assert extract_features(polish_text).values["contraction_rate"] == 0.0


def test_empty_text_does_not_explode():
    features = extract_features("")
    assert features.n_words == 0
    assert all(value == 0.0 for value in features.values.values())
