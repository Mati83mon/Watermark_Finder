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


class TestCodeBlocksAreNotProse:
    """Fenced blocks are a listing, not the author's writing.

    Measured on this repository's README: all 69 double-space runs the typo
    detector fired on were inside ``` blocks - ASCII diagrams and aligned
    output. None in prose, none in tables. Counting them read deliberate
    alignment as the accidental double-tap of someone typing, and moved the
    document's style score by ten points.
    """

    DOC = (
        "This paragraph is ordinary prose written by a person.\n"
        "It runs to a couple of sentences so the features have something to chew on.\n"
        "\n"
        "```\n"
        "MARK  ---------->  DETECT  ---------->  CLEAN\n"
        "one copy          hidden chars        remove them\n"
        "```\n"
        "\n"
        "And a closing paragraph, also prose.\n"
    )

    def test_alignment_inside_a_fence_is_not_a_typing_slip(self):
        assert extract_features(self.DOC).values["typo_indicator_rate"] == 0.0

    def test_the_same_spacing_in_prose_still_counts(self):
        # Outside a fence the identical run is exactly what the feature is for.
        slipped = self.DOC.replace(
            "And a closing paragraph, also prose.",
            "And a closing  paragraph, also  prose.",
        )
        assert extract_features(slipped).values["typo_indicator_rate"] > 0.0

    def test_prose_around_the_block_is_kept(self):
        from tpl.features import prose_only

        kept = prose_only(self.DOC)
        assert "ordinary prose" in kept
        assert "closing paragraph" in kept
        assert "MARK" not in kept

    def test_line_structure_survives(self):
        from tpl.features import prose_only

        assert prose_only(self.DOC).count("\n") == self.DOC.count("\n")

    def test_an_unterminated_fence_does_not_swallow_the_document(self):
        from tpl.features import prose_only

        text = "Real prose here.\n```\ncode\n"
        assert "Real prose here." in prose_only(text)


class TestReportedSizeDescribesTheDocument:
    """A report that states a size has to state the document's size.

    Excluding fenced blocks from measurement made the header read "9049
    characters" for an 18685-character file, while the segment table in the
    same report listed offsets up to 18688 and the SHA-256 covered the whole
    thing. One report cannot disagree with itself about how big the document is.
    """

    DOC = "Prose before.\n\n```\ncode  aligned  here\nmore  code\n```\n\nProse after.\n"

    def test_source_counts_cover_the_whole_document(self):
        f = extract_features(self.DOC)
        assert f.n_chars_source == len(self.DOC)

    def test_measured_counts_cover_the_prose_only(self):
        f = extract_features(self.DOC)
        assert f.n_chars < f.n_chars_source
        assert f.excluded_chars > 0

    def test_a_document_without_code_reports_one_size(self):
        plain = "Just prose here. And a second sentence for good measure.\n"
        f = extract_features(plain)
        assert f.n_chars == f.n_chars_source
        assert f.excluded_chars == 0

    def test_the_report_states_the_document_size_and_says_what_it_excluded(self):
        from tpl.pipeline import analyse

        report = analyse(self.DOC, "quick")["technical_report_markdown"]
        assert f"**Size**: {len(self.DOC)} characters" in report
        assert "excluded" in report
