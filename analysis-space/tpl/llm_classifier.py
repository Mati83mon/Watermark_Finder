"""Style scoring: how much a document reads like unedited assistant output.

Two interchangeable models implement the same interface:

:class:`PriorStyleModel`
    A logistic model whose coefficients are an explicit, documented prior rather
    than fitted parameters. It ships with the service so that a fresh deployment
    is useful immediately, and it reports ``trained=False`` so the UI can label
    the number honestly.

:class:`TrainedStyleModel`
    A scikit-learn pipeline loaded from ``models/style_clf.joblib``. It is
    produced by ``train.py`` from a labelled corpus and, once present, takes
    precedence automatically.

Both return a probability *with an uncertainty band*. Short inputs are shrunk
towards 0.5 and get a wide band, because no stylometric method can separate
authorship from a paragraph of text. This is a register classifier, not an
authorship oracle - the wording of every label in this module reflects that.
"""

from __future__ import annotations

import json
import logging
import math
import os
from dataclasses import dataclass, field
from pathlib import Path

from .features import FEATURE_ORDER, FeatureSet

logger = logging.getLogger(__name__)

MODEL_DIR = Path(os.environ.get("TPL_MODEL_DIR", Path(__file__).resolve().parent.parent / "models"))
MODEL_PATH = MODEL_DIR / "style_clf.joblib"
METRICS_PATH = MODEL_DIR / "metrics.json"

#: Below this many words the classifier refuses to commit to a label.
MIN_WORDS_FOR_VERDICT = 15
#: Word count at which the shrinkage factor reaches 1.0.
FULL_CONFIDENCE_WORDS = 150

LABEL_INSUFFICIENT = "insufficient_evidence"
LABEL_HUMAN = "likely_human"
LABEL_INCONCLUSIVE = "inconclusive"
LABEL_AI = "likely_ai"
LABEL_STRONG_AI = "very_likely_ai"


@dataclass(frozen=True)
class Prior:
    """A documented coefficient for one feature.

    ``mean``/``std`` describe the reference distribution used to standardise the
    feature; ``weight`` is the log-odds contribution per standard deviation, and
    a positive weight pushes towards "assistant register".
    """

    mean: float
    std: float
    weight: float
    rationale: str
    languages: tuple[str, ...] | None = None


#: Reference distribution and log-odds weight per feature.
PRIORS: dict[str, Prior] = {
    "sentence_length_cv": Prior(
        0.55,
        0.18,
        -0.85,
        "Human prose alternates short and long sentences; generated text is far more uniform.",
    ),
    "assistant_lexicon_rate": Prior(
        0.35,
        0.45,
        0.95,
        "Register vocabulary ('leverage', 'kluczowe', 'seamless') is the single strongest lexical tell.",
    ),
    "discourse_marker_rate": Prior(
        0.55,
        0.60,
        0.75,
        "Explicit connectives are used two to three times more often in assistant output.",
    ),
    "typo_indicator_rate": Prior(
        0.55,
        1.00,
        -0.60,
        "Double spaces, '!!' and missing spaces after commas almost never survive generation.",
    ),
    "hedge_rate": Prior(
        0.20,
        0.35,
        0.50,
        "Hedges and disclaimers are a byproduct of instruction tuning.",
    ),
    "contraction_rate": Prior(
        0.90,
        1.00,
        -0.45,
        "English contractions mark an informal register that models under-produce.",
        languages=("en",),
    ),
    "em_dash_rate": Prior(
        0.35,
        0.80,
        0.45,
        "Em dashes require a deliberate keystroke for most writers but are emitted freely by models.",
    ),
    "personal_pronoun_rate": Prior(
        1.60,
        1.60,
        -0.35,
        "First-person reference is common in human writing and suppressed in neutral explanatory output.",
    ),
    "paragraph_length_cv": Prior(
        0.50,
        0.25,
        -0.30,
        "Generated paragraphs cluster around a similar length.",
    ),
    "bullet_line_ratio": Prior(
        0.12,
        0.22,
        0.30,
        "List-heavy layout is the default answer shape of a chat assistant.",
    ),
    "mean_sentence_length": Prior(
        17.5,
        6.0,
        0.30,
        "Generated sentences trend longer than conversational human writing.",
    ),
    "long_word_ratio": Prior(
        0.22,
        0.08,
        0.25,
        "A formal, latinate register raises the share of long words.",
    ),
    "sentence_start_repetition": Prior(
        0.18,
        0.15,
        0.25,
        "Repeated sentence openings reflect template-like construction.",
    ),
    "curly_quote_ratio": Prior(
        0.35,
        0.40,
        0.25,
        "Typographic quotes come from a generator or a word processor, rarely from raw typing.",
    ),
    "mean_word_length": Prior(
        4.90,
        0.70,
        0.20,
        "Correlates with formal register; kept at low weight because it is language dependent.",
    ),
    "exclamation_rate": Prior(
        0.25,
        0.70,
        -0.20,
        "Exclamation marks indicate an unedited human voice.",
    ),
    "comma_per_sentence": Prior(
        1.50,
        0.80,
        0.15,
        "Subordinate-clause density is mildly higher in generated prose.",
    ),
    "ellipsis_char_rate": Prior(
        0.10,
        0.35,
        0.15,
        "The single-character ellipsis is a generator artefact.",
    ),
}

#: Lexical-diversity features are computed and reported, but deliberately do
#: not score. Both were measured against every sample available and neither
#: behaves the way a scoring feature must.
#:
#: ``mattr``
#:     The prior mean was taken from published type-token ratios for large
#:     corpora, but the feature measures a moving average over a 50-word window,
#:     which is a different quantity on a different scale. Every real sample -
#:     human and generated, English and Polish - landed between +1.9 and +3.7
#:     standard deviations above that mean, so the term was pinned at the
#:     clipping ceiling and contributed a constant, not a signal.
#:
#: ``hapax_ratio``
#:     Measured across document lengths it falls 0.85 -> 0.49 -> 0.07 -> 0.00
#:     between 300 and 2400 words. That is the documented behaviour of hapax
#:     measures, not a defect, but it means the feature tracks document length
#:     as much as vocabulary, and a length-varying quantity cannot be compared
#:     against a fixed mean.
#:
#: Together they added roughly -0.57 log-odds towards "human" to every score
#: regardless of content, pulling a neutral document from 50% to 36%. Removing
#: them removes a bias, not evidence. They belong back in the model only with a
#: length-normalised estimator and means measured from a labelled corpus.
UNSCORED_FEATURES: tuple[str, ...] = ("mattr", "hapax_ratio")

#: Intercept: a neutral document leans slightly human.
PRIOR_BIAS = -0.35
#: Temperature on the linear term, chosen so a maximally "assistant-like"
#: document lands near 0.95 instead of saturating at 1.0.
PRIOR_TEMPERATURE = 0.45
Z_CLIP = 2.5


@dataclass
class Contribution:
    feature: str
    value: float
    z: float
    contribution: float
    rationale: str

    def as_dict(self) -> dict[str, object]:
        return {
            "feature": self.feature,
            "value": round(self.value, 4),
            "z": round(self.z, 3),
            "contribution": round(self.contribution, 4),
            "direction": "assistant" if self.contribution > 0 else "human",
            "rationale": self.rationale,
        }


@dataclass
class StyleScore:
    value: float
    low: float
    high: float
    label: str
    confidence: str
    model_id: str
    trained: bool
    contributions: list[Contribution] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {
            "value": round(self.value, 4),
            "low": round(self.low, 4),
            "high": round(self.high, 4),
            "label": self.label,
            "confidence": self.confidence,
            "model_id": self.model_id,
            "trained": self.trained,
            "contributions": [c.as_dict() for c in self.contributions],
            "notes": self.notes,
        }


def _sigmoid(x: float) -> float:
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    exp_x = math.exp(x)
    return exp_x / (1.0 + exp_x)


def _shrinkage(n_words: int) -> float:
    """How much of the raw signal to keep, given the amount of evidence."""
    return min(1.0, math.sqrt(max(n_words, 0) / FULL_CONFIDENCE_WORDS))


def _band(n_words: int) -> float:
    half = 0.5 / math.sqrt(max(n_words, 1) / 60.0)
    return max(0.05, min(0.35, half))


def _label_for(value: float, n_words: int) -> str:
    if n_words < MIN_WORDS_FOR_VERDICT:
        return LABEL_INSUFFICIENT
    if value >= 0.85:
        return LABEL_STRONG_AI
    if value >= 0.65:
        return LABEL_AI
    if value <= 0.35:
        return LABEL_HUMAN
    return LABEL_INCONCLUSIVE


def _confidence_for(n_words: int, band: float) -> str:
    if n_words < MIN_WORDS_FOR_VERDICT:
        return "none"
    if band <= 0.12 and n_words >= 250:
        return "high"
    if band <= 0.22:
        return "medium"
    return "low"


class StyleModel:
    """Common interface for both scorers."""

    model_id = "abstract"
    trained = False

    def predict(self, features: FeatureSet) -> StyleScore:  # pragma: no cover - interface
        raise NotImplementedError


class PriorStyleModel(StyleModel):
    """Explainable logistic model built from documented priors."""

    model_id = "prior-logistic-v1"
    trained = False

    def predict(self, features: FeatureSet) -> StyleScore:
        notes: list[str] = []
        contributions: list[Contribution] = []
        total = PRIOR_BIAS

        for name, prior in PRIORS.items():
            if prior.languages and features.language not in prior.languages:
                continue
            value = features.values.get(name)
            if value is None:
                continue
            z = (value - prior.mean) / prior.std
            z = max(-Z_CLIP, min(Z_CLIP, z))
            contribution = prior.weight * z * PRIOR_TEMPERATURE
            total += contribution
            contributions.append(Contribution(name, value, z, contribution, prior.rationale))

        raw = _sigmoid(total)
        shrink = _shrinkage(features.n_words)
        value = 0.5 + (raw - 0.5) * shrink
        value = max(0.02, min(0.98, value))

        band = _band(features.n_words)
        label = _label_for(value, features.n_words)
        confidence = _confidence_for(features.n_words, band)

        if features.n_words < MIN_WORDS_FOR_VERDICT:
            notes.append(
                f"Only {features.n_words} words: too little text for any stylometric verdict."
            )
        elif features.n_words < FULL_CONFIDENCE_WORDS:
            notes.append(
                f"{features.n_words} words is below the {FULL_CONFIDENCE_WORDS}-word "
                "threshold, so the score is pulled towards 0.5."
            )
        if features.language == "unknown":
            notes.append(
                "Language could not be identified; English marker lists were used as a fallback."
            )
        notes.append(
            "Coefficients are a documented prior, not parameters fitted to a labelled corpus."
        )

        contributions.sort(key=lambda c: -abs(c.contribution))
        return StyleScore(
            value=value,
            low=max(0.0, value - band),
            high=min(1.0, value + band),
            label=label,
            confidence=confidence,
            model_id=self.model_id,
            trained=False,
            contributions=contributions[:10],
            notes=notes,
        )


class TrainedStyleModel(StyleModel):
    """scikit-learn pipeline produced by ``train.py``."""

    trained = True

    def __init__(self, pipeline, metadata: dict[str, object]):
        self._pipeline = pipeline
        self.metadata = metadata
        self.model_id = str(metadata.get("model_id", "trained-logistic"))
        self._feature_order: list[str] = list(metadata.get("feature_order", list(FEATURE_ORDER)))

    @classmethod
    def load(cls, path: Path | None = None) -> TrainedStyleModel | None:
        # Resolved at call time, not import time, so the artefact location can
        # be changed after the module has been imported.
        path = path or MODEL_PATH
        if not path.exists():
            return None
        try:
            import joblib  # imported lazily: optional at runtime
        except ImportError:
            logger.warning("joblib is not installed; falling back to the prior model")
            return None
        try:
            bundle = joblib.load(path)
            return cls(bundle["pipeline"], bundle.get("metadata", {}))
        except Exception:  # pragma: no cover - defensive, corrupt artefact
            logger.exception("Failed to load %s; falling back to the prior model", path)
            return None

    def predict(self, features: FeatureSet) -> StyleScore:
        vector = [[features.values.get(name, 0.0) for name in self._feature_order]]
        raw = float(self._pipeline.predict_proba(vector)[0][1])

        shrink = _shrinkage(features.n_words)
        value = max(0.02, min(0.98, 0.5 + (raw - 0.5) * shrink))
        band = _band(features.n_words)
        notes = [
            "Score produced by a model fitted on a labelled corpus; see /version for its metrics."
        ]
        if features.n_words < MIN_WORDS_FOR_VERDICT:
            notes.append(
                f"Only {features.n_words} words: too little text for any stylometric verdict."
            )
        return StyleScore(
            value=value,
            low=max(0.0, value - band),
            high=min(1.0, value + band),
            label=_label_for(value, features.n_words),
            confidence=_confidence_for(features.n_words, band),
            model_id=self.model_id,
            trained=True,
            contributions=[],
            notes=notes,
        )


_cached_model: StyleModel | None = None


def load_model(force_prior: bool = False) -> StyleModel:
    """Return the trained model when an artefact exists, otherwise the prior."""
    global _cached_model
    if _cached_model is not None and not force_prior:
        return _cached_model
    model: StyleModel | None = None
    if not force_prior:
        model = TrainedStyleModel.load()
    if model is None:
        model = PriorStyleModel()
    _cached_model = model
    return model


def model_metrics() -> dict[str, object]:
    """Training metrics for the active model, if any were published."""
    if METRICS_PATH.exists():
        try:
            return json.loads(METRICS_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:  # pragma: no cover - defensive
            logger.warning("metrics.json is not valid JSON")
    return {}


def reset_model_cache() -> None:
    global _cached_model
    _cached_model = None


__all__ = [
    "Contribution",
    "LABEL_AI",
    "LABEL_HUMAN",
    "LABEL_INCONCLUSIVE",
    "LABEL_INSUFFICIENT",
    "LABEL_STRONG_AI",
    "MIN_WORDS_FOR_VERDICT",
    "PRIORS",
    "PriorStyleModel",
    "StyleModel",
    "StyleScore",
    "TrainedStyleModel",
    "load_model",
    "model_metrics",
    "reset_model_cache",
]
