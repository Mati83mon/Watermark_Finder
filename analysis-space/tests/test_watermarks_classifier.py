from __future__ import annotations

from tpl.features import extract_features
from tpl.llm_classifier import (
    LABEL_INSUFFICIENT,
    MIN_WORDS_FOR_VERDICT,
    PriorStyleModel,
    load_model,
)
from tpl.preprocessing import encode_tag_characters, encode_zero_width_binary, preprocess
from tpl.watermark_heuristics import analyse_watermarks


def _score(text: str) -> float:
    return analyse_watermarks(preprocess(text)).score


def test_clean_prose_scores_low(human_text):
    result = analyse_watermarks(preprocess(human_text))
    assert result.score < 0.35
    assert result.label in ("clean", "weak_indicators")


def test_decoded_payload_dominates_the_score():
    text = "An ordinary looking paragraph." + encode_tag_characters("watermark-id-88")
    result = analyse_watermarks(preprocess(text))
    assert result.score >= 0.95
    assert result.label == "payload_recovered"
    assert result.confidence == "high"
    assert any(signal.id.startswith("payload_") for signal in result.signals)


def test_zero_width_cluster_without_payload_is_still_flagged():
    text = "Some text " + "​" * 12 + " more text"
    result = analyse_watermarks(preprocess(text))
    assert result.score >= 0.5
    assert any(signal.id == "invisible_characters" for signal in result.signals)


def test_more_carriers_never_lowers_the_score():
    low = _score("Body text " + "​" * 2)
    high = _score("Body text " + "​" * 40)
    assert high >= low


def test_homoglyph_signal_fires():
    result = analyse_watermarks(preprocess("Please reset your pаssword and lоgin again."))
    ids = {signal.id for signal in result.signals}
    assert "homoglyph_substitution" in ids
    assert result.score >= 0.4


def test_bidi_controls_flagged():
    result = analyse_watermarks(preprocess("invoice‮gnp.txt attached"))
    assert any(signal.id == "bidi_controls" for signal in result.signals)


def test_style_alone_cannot_claim_a_watermark(assistant_text):
    result = analyse_watermarks(preprocess(assistant_text))
    assert result.score < 0.5
    assert result.label in ("clean", "weak_indicators")


def test_signal_dicts_are_serialisable():
    result = analyse_watermarks(preprocess("Text " + encode_zero_width_binary("hi")))
    for signal in result.signals:
        payload = signal.as_dict()
        assert set(payload) >= {"id", "category", "score", "severity", "evidence"}
        assert isinstance(payload["evidence"], list)


# --------------------------------------------------------------------------
# Style classifier
# --------------------------------------------------------------------------
def test_assistant_text_scores_higher_than_human(human_text, assistant_text):
    model = PriorStyleModel()
    human = model.predict(extract_features(human_text))
    assistant = model.predict(extract_features(assistant_text))
    assert assistant.value > human.value
    assert assistant.value - human.value > 0.15


def test_short_text_gets_no_verdict():
    model = PriorStyleModel()
    score = model.predict(extract_features("Too short to judge."))
    assert score.label == LABEL_INSUFFICIENT
    assert score.confidence == "none"
    assert abs(score.value - 0.5) < 0.25


def test_band_narrows_as_text_grows(human_text):
    model = PriorStyleModel()
    short = model.predict(extract_features(" ".join(human_text.split()[:40])))
    long = model.predict(extract_features(human_text * 4))
    assert (long.high - long.low) < (short.high - short.low)


def test_scores_stay_inside_unit_interval(human_text, assistant_text, polish_text):
    model = PriorStyleModel()
    for text in (human_text, assistant_text, polish_text, "x", ""):
        score = model.predict(extract_features(text))
        assert 0.0 <= score.low <= score.value <= score.high <= 1.0


def test_prior_model_is_transparent(assistant_text):
    score = PriorStyleModel().predict(extract_features(assistant_text))
    assert score.trained is False
    assert score.contributions
    assert any("prior" in note.lower() for note in score.notes)
    top = score.contributions[0]
    assert top.rationale


def test_polish_text_is_scored_with_polish_markers(polish_text):
    score = PriorStyleModel().predict(extract_features(polish_text))
    features = extract_features(polish_text)
    assert features.language == "pl"
    assert features.values["discourse_marker_rate"] > 0
    assert score.value > 0.5


def test_load_model_falls_back_to_prior_without_artifact():
    model = load_model()
    assert model.model_id == "prior-logistic-v1"
    assert model.trained is False


def test_min_words_threshold_is_respected():
    model = PriorStyleModel()
    text = " ".join(["word"] * (MIN_WORDS_FOR_VERDICT - 1))
    assert model.predict(extract_features(text)).label == LABEL_INSUFFICIENT
