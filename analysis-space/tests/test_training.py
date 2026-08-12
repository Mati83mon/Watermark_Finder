"""Tests for the training script and the trained-model code path.

The corpus used here is generated programmatically from the two fixture styles.
It exists to prove the *plumbing* works - loading, validation, cross-validation,
serialisation, and the runtime falling back or picking the artefact up. It is
not a claim that a model fitted on it detects anything in the real world, which
is exactly why ``train.py`` refuses to build an artefact from a corpus this
small unless ``--force`` is passed.
"""

from __future__ import annotations

import json
import random

import pytest

from tpl.features import extract_features
from tpl.llm_classifier import TrainedStyleModel, load_model, reset_model_cache

train_module = pytest.importorskip("train")
pytest.importorskip("sklearn")


def _variants(text: str, count: int, seed: int) -> list[str]:
    """Shuffle sentence order to create distinct but style-preserving samples."""
    rng = random.Random(seed)
    sentences = [s.strip() for s in text.replace("\n", " ").split(". ") if s.strip()]
    out = []
    for index in range(count):
        pool = sentences[:]
        rng.shuffle(pool)
        out.append(". ".join(pool) + f". Sample {index}.")
    return out


def _write_corpus(directory, human_text: str, assistant_text: str, per_class: int) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    records = []
    for text in _variants(human_text, per_class, seed=1):
        records.append({"text": text, "label": "human", "source": "fixture-human"})
    for text in _variants(assistant_text, per_class, seed=2):
        records.append({"text": text, "label": "ai", "source": "fixture-assistant"})
    (directory / "fixture.jsonl").write_text(
        "\n".join(json.dumps(record, ensure_ascii=False) for record in records),
        encoding="utf-8",
    )


def test_load_corpus_validates_labels(tmp_path):
    (tmp_path / "bad.jsonl").write_text(
        json.dumps({"text": "word " * 60, "label": "maybe"}), encoding="utf-8"
    )
    with pytest.raises(SystemExit, match="label must be one of"):
        train_module.load_corpus(tmp_path)


def test_load_corpus_skips_short_samples(tmp_path, human_text):
    (tmp_path / "mixed.jsonl").write_text(
        "\n".join(
            [
                json.dumps({"text": "too short", "label": "human"}),
                json.dumps({"text": human_text, "label": "human"}),
            ]
        ),
        encoding="utf-8",
    )
    samples = train_module.load_corpus(tmp_path)
    assert len(samples) == 1


def test_empty_corpus_directory_is_an_error(tmp_path):
    with pytest.raises(SystemExit, match="No .jsonl files"):
        train_module.load_corpus(tmp_path)


def test_training_refuses_a_tiny_corpus(tmp_path, human_text, assistant_text):
    corpus = tmp_path / "corpus"
    _write_corpus(corpus, human_text, assistant_text, per_class=4)
    with pytest.raises(SystemExit, match="Refusing to train"):
        train_module.train(corpus, tmp_path / "models")


def test_forced_training_produces_a_loadable_artifact(
    tmp_path, monkeypatch, human_text, assistant_text
):
    corpus = tmp_path / "corpus"
    out = tmp_path / "models"
    _write_corpus(corpus, human_text, assistant_text, per_class=12)

    metrics = train_module.train(corpus, out, folds=3, force=True)

    assert (out / "style_clf.joblib").exists()
    assert (out / "metrics.json").exists()
    assert metrics["class_counts"] == {"human": 12, "ai": 12}
    assert 0.0 <= metrics["cross_validation"]["f1"] <= 1.0
    assert set(metrics["coefficients"]) == set(train_module.FEATURE_ORDER)
    assert metrics["caveats"]

    model = TrainedStyleModel.load(out / "style_clf.joblib")
    assert model is not None
    assert model.trained is True

    score = model.predict(extract_features(assistant_text))
    assert 0.0 <= score.low <= score.value <= score.high <= 1.0
    assert score.trained is True

    # With TPL_MODEL_DIR pointed at the artefact, load_model() must prefer it.
    monkeypatch.setattr("tpl.llm_classifier.MODEL_PATH", out / "style_clf.joblib")
    reset_model_cache()
    assert load_model().trained is True
    reset_model_cache()


def test_missing_artifact_falls_back_to_prior(tmp_path, monkeypatch):
    monkeypatch.setattr("tpl.llm_classifier.MODEL_PATH", tmp_path / "absent.joblib")
    reset_model_cache()
    model = load_model()
    assert model.trained is False
    assert model.model_id == "prior-logistic-v1"
