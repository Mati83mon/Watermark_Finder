#!/usr/bin/env python3
"""Fit the style classifier on a labelled corpus.

Usage
-----
::

    python train.py --corpus data/corpus --out models

The corpus is one or more JSONL files with objects shaped like::

    {"text": "...", "label": "human" | "ai", "source": "where it came from"}

The script refuses to produce an artefact from a corpus that is too small to
support one. That guard is deliberate: a model fitted on a handful of examples
would report confident probabilities it cannot justify, and the service already
has an honest fallback (the documented prior model) for that case. Use
``--force`` only when you know why you are overriding it.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from tpl.config import VERSION
from tpl.features import FEATURE_ORDER, extract_features

logger = logging.getLogger("tpl.train")

LABELS = {"human": 0, "ai": 1}
DEFAULT_MIN_PER_CLASS = 50
MIN_WORDS = 40


@dataclass
class Sample:
    text: str
    label: int
    source: str


def load_corpus(directory: Path) -> list[Sample]:
    """Read every ``*.jsonl`` file under ``directory``."""
    samples: list[Sample] = []
    files = sorted(directory.glob("*.jsonl"))
    if not files:
        raise SystemExit(f"No .jsonl files found in {directory}")

    for path in files:
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            line = line.strip()
            if not line or line.startswith("//"):
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"{path}:{line_number}: invalid JSON ({exc})") from exc
            text = (record.get("text") or "").strip()
            label = record.get("label")
            if label not in LABELS:
                raise SystemExit(
                    f"{path}:{line_number}: label must be one of {sorted(LABELS)}, got {label!r}"
                )
            if len(text.split()) < MIN_WORDS:
                logger.warning(
                    "%s:%s: skipping sample with fewer than %d words", path, line_number, MIN_WORDS
                )
                continue
            samples.append(
                Sample(text=text, label=LABELS[label], source=record.get("source", path.name))
            )
    return samples


def build_matrix(samples: Sequence[Sample]) -> tuple[list[list[float]], list[int]]:
    features = []
    labels = []
    for sample in samples:
        feature_set = extract_features(sample.text)
        features.append([feature_set.values[name] for name in FEATURE_ORDER])
        labels.append(sample.label)
    return features, labels


def _class_counts(labels: Sequence[int]) -> dict[str, int]:
    return {
        "human": sum(1 for label in labels if label == 0),
        "ai": sum(1 for label in labels if label == 1),
    }


def train(
    corpus_dir: Path,
    out_dir: Path,
    *,
    folds: int = 5,
    seed: int = 20240501,
    min_per_class: int = DEFAULT_MIN_PER_CLASS,
    force: bool = False,
) -> dict[str, object]:
    try:
        import joblib
        import numpy as np
        from sklearn.linear_model import LogisticRegression
        from sklearn.metrics import (
            accuracy_score,
            f1_score,
            precision_score,
            recall_score,
            roc_auc_score,
        )
        from sklearn.model_selection import StratifiedKFold
        from sklearn.pipeline import Pipeline
        from sklearn.preprocessing import StandardScaler
    except ImportError as exc:  # pragma: no cover - depends on install
        raise SystemExit(
            "Training requires scikit-learn and joblib: pip install -r requirements-dev.txt"
        ) from exc

    samples = load_corpus(corpus_dir)
    counts = _class_counts([s.label for s in samples])
    logger.info("Loaded %d samples: %s", len(samples), counts)

    if not force and min(counts.values()) < min_per_class:
        raise SystemExit(
            f"Refusing to train: need at least {min_per_class} samples per class, have {counts}. "
            "The service falls back to the documented prior model, which is more honest than a "
            "model fitted on this little data. Pass --force to override."
        )

    features, labels = build_matrix(samples)
    X = np.asarray(features, dtype=float)
    y = np.asarray(labels, dtype=int)

    def make_pipeline() -> Pipeline:
        return Pipeline(
            [
                ("scale", StandardScaler()),
                (
                    "clf",
                    LogisticRegression(
                        C=1.0,
                        max_iter=2000,
                        class_weight="balanced",
                        random_state=seed,
                    ),
                ),
            ]
        )

    effective_folds = max(2, min(folds, min(counts.values())))
    splitter = StratifiedKFold(n_splits=effective_folds, shuffle=True, random_state=seed)
    fold_metrics: list[dict[str, float]] = []
    for index, (train_idx, test_idx) in enumerate(splitter.split(X, y)):
        pipeline = make_pipeline()
        pipeline.fit(X[train_idx], y[train_idx])
        predictions = pipeline.predict(X[test_idx])
        probabilities = pipeline.predict_proba(X[test_idx])[:, 1]
        fold_metrics.append(
            {
                "fold": index,
                "accuracy": float(accuracy_score(y[test_idx], predictions)),
                "precision": float(precision_score(y[test_idx], predictions, zero_division=0)),
                "recall": float(recall_score(y[test_idx], predictions, zero_division=0)),
                "f1": float(f1_score(y[test_idx], predictions, zero_division=0)),
                "roc_auc": float(roc_auc_score(y[test_idx], probabilities))
                if len(set(y[test_idx])) > 1
                else float("nan"),
            }
        )

    def mean(key: str) -> float:
        values = [m[key] for m in fold_metrics if m[key] == m[key]]  # drop NaN
        return round(sum(values) / len(values), 4) if values else float("nan")

    final = make_pipeline()
    final.fit(X, y)

    coefficients = dict(
        zip(
            FEATURE_ORDER,
            (round(float(c), 5) for c in final.named_steps["clf"].coef_[0]),
            strict=False,
        )
    )

    metadata = {
        "model_id": f"trained-logistic-{datetime.now(UTC):%Y%m%d}",
        "engine_version": VERSION,
        "feature_order": list(FEATURE_ORDER),
        "trained_at": datetime.now(UTC).isoformat(),
        "sample_count": len(samples),
        "class_counts": counts,
        "sources": sorted({sample.source for sample in samples}),
        "seed": seed,
    }

    metrics = {
        **metadata,
        "cross_validation": {
            "folds": effective_folds,
            "accuracy": mean("accuracy"),
            "precision": mean("precision"),
            "recall": mean("recall"),
            "f1": mean("f1"),
            "roc_auc": mean("roc_auc"),
            "per_fold": fold_metrics,
        },
        "coefficients": coefficients,
        "caveats": [
            "Metrics describe held-out folds of this corpus only; they do not transfer to "
            "text from a different domain, language or generator.",
            "The classifier measures register, not authorship.",
        ],
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    joblib.dump({"pipeline": final, "metadata": metadata}, out_dir / "style_clf.joblib")
    (out_dir / "metrics.json").write_text(
        json.dumps(metrics, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    logger.info(
        "Wrote %s and %s (CV f1=%.3f, roc_auc=%.3f)",
        out_dir / "style_clf.joblib",
        out_dir / "metrics.json",
        metrics["cross_validation"]["f1"],
        metrics["cross_validation"]["roc_auc"],
    )
    return metrics


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, default=Path("data/corpus"))
    parser.add_argument("--out", type=Path, default=Path("models"))
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--seed", type=int, default=20240501)
    parser.add_argument("--min-per-class", type=int, default=DEFAULT_MIN_PER_CLASS)
    parser.add_argument(
        "--force",
        action="store_true",
        help="Train even when the corpus is smaller than the safety threshold.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    train(
        args.corpus,
        args.out,
        folds=args.folds,
        seed=args.seed,
        min_per_class=args.min_per_class,
        force=args.force,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
