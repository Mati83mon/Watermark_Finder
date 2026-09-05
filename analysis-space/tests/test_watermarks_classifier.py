from __future__ import annotations

from tpl.features import extract_features
from tpl.llm_classifier import (
    LABEL_INSUFFICIENT,
    MIN_WORDS_FOR_VERDICT,
    PriorStyleModel,
    load_model,
)
from tpl.preprocessing import encode_tag_characters, encode_zero_width_binary, preprocess
from tpl.watermark_heuristics import CATEGORY_STYLISTIC, analyse_watermarks


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


# --------------------------------------------------------------------------
# Repetition stamps
#
# A watermark drawn behind a page or in white text is invisible when rendered
# and fully present once the PDF has been through text extraction. It arrives as
# one phrase repeated back to back, which is a shape prose never takes.
# --------------------------------------------------------------------------
_STAMP = "Witaj Tu Sie Ukrylem\n" * 44
_DOCUMENT = (
    "Pilka treningowa ProSport X to uniwersalna pilka przeznaczona do rekreacyjnej "
    "gry na hali, boisku szkolnym oraz na nawierzchniach syntetycznych. Konstrukcja "
    "zostala zaprojektowana z myslą o komforcie uzytkowania i stabilnym locie. "
    "Material to syntetyczna powloka, a szycie maszynowe zapewnia trwalosc przy "
    "codziennym treningu. Pilka nadaje sie dla poczatkujacych i sredniozaawansowanych."
)


def test_repetition_stamp_is_detected_as_byte_evidence():
    result = analyse_watermarks(preprocess(_STAMP + _DOCUMENT))
    assert any(signal.id == "repetition_stamp" for signal in result.signals)
    assert result.basis == "bytes"
    assert result.label == "watermark_detected"


def test_repetition_stamp_beats_the_stylistic_cap():
    """The whole point: a stamp must not be filed as a capped style hint."""
    stamped = analyse_watermarks(preprocess(_STAMP + _DOCUMENT))
    assert stamped.score > 0.45, "0.45 is the ceiling stylistic evidence cannot pass"


def test_document_without_the_stamp_stays_clean():
    result = analyse_watermarks(preprocess(_DOCUMENT))
    assert not any(signal.id == "repetition_stamp" for signal in result.signals)


def test_a_refrain_is_not_a_stamp():
    """A song repeats its chorus as much as the stamp repeats, but spreads it out."""
    verse = "Szedlem przez miasto w deszczu i myslalem o tobie ciagle wieczorem\n"
    chorus = "I nie wroce juz nigdy tam gdzie bylem wczoraj\n"
    lyrics = (verse + chorus) * 8
    result = analyse_watermarks(preprocess(lyrics))
    assert not any(signal.id == "repetition_stamp" for signal in result.signals)


def test_a_footer_repeated_on_every_page_is_not_a_stamp():
    page = (
        "Raport kwartalny dzialu sprzedazy przedstawia wyniki za okres trzech "
        "miesiecy oraz porownanie do poprzedniego kwartalu w kazdym regionie.\n"
        "Poufne - wlasnosc firmy - nie rozpowszechniac\n"
    )
    result = analyse_watermarks(preprocess(page * 12))
    assert not any(signal.id == "repetition_stamp" for signal in result.signals)


def test_single_word_filler_is_not_a_stamp():
    """"na na na na na" carries no phrase, so it says nothing about intent."""
    result = analyse_watermarks(preprocess("na " * 400 + _DOCUMENT))
    assert not any(signal.id == "repetition_stamp" for signal in result.signals)


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


class TestScoreBasis:
    """A stylistic hint must never be presented as byte-level evidence.

    The result page prints "Deterministic: based on the actual bytes of the
    document" under the watermark score. That sentence holds only when a
    covert-channel or obfuscation signal actually fired. A document scoring 21%
    purely on em dash frequency has nothing in its bytes, and captioning that
    number "deterministic" invites the reader to treat a guess as proof.
    """

    def test_clean_text_reports_no_basis(self):
        result = analyse_watermarks(preprocess("Zwykle zdanie bez zadnych sztuczek."))
        assert result.basis == "none"

    def test_hidden_characters_report_byte_basis(self):
        marked = "Zwykle zdanie." + encode_tag_characters("owner:test|id:42")
        result = analyse_watermarks(preprocess(marked))
        assert result.basis == "bytes"

    def test_style_only_score_is_not_called_deterministic(self):
        # Em dashes and nothing else: the typography signal fires, no covert
        # channel does. This is the shape that produced 21% on a document
        # containing zero hidden characters.
        text = " ".join(["Zdanie - z myslnikiem \u2014 i kolejnym \u2014 tutaj."] * 40)
        result = analyse_watermarks(preprocess(text))
        assert result.basis == "stylistic"
        assert all(s.category == CATEGORY_STYLISTIC for s in result.signals)
        # The 0.45 cap keeps a style-only score below the "suspected" band.
        assert result.score < 0.5
