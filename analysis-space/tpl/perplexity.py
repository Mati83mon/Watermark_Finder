"""Optional surprisal analysis with a small local causal language model.

Disabled by default. When ``TPL_ENABLE_PERPLEXITY=1`` and ``transformers`` plus
``torch`` are installed, the service loads a small model (``distilgpt2`` by
default, ~350 MB, comfortable on the free CPU tier) and measures two quantities
over the input:

``mean_surprisal``
    Average negative log-likelihood per token. Text sampled from a language
    model sits in a lower-surprisal region than spontaneous human writing.

``surprisal_cv``
    Coefficient of variation of per-token surprisal. Human text is *bursty*:
    occasional very surprising tokens between predictable ones. Decoded output
    is flatter.

Neither number is a verdict. They are folded into the final score with a modest
weight and always reported alongside the model that produced them.

Everything is loaded lazily and every failure degrades to "unavailable" rather
than breaking the request.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass

logger = logging.getLogger(__name__)

DEFAULT_MODEL = os.environ.get("TPL_PERPLEXITY_MODEL", "distilgpt2")
MAX_TOKENS = int(os.environ.get("TPL_PERPLEXITY_MAX_TOKENS", "512"))

#: Reference points for mapping surprisal onto a 0-1 "looks generated" signal.
#: Chosen from published perplexity ranges for small GPT-2 class models: human
#: web text averages roughly 4.5 nats/token, sampled model output roughly 2.5.
SURPRISAL_HUMAN = 4.5
SURPRISAL_MODEL = 2.5
CV_HUMAN = 0.85
CV_MODEL = 0.55

_lock = threading.Lock()
_loaded: _Backend | None = None
_load_failed = False


@dataclass
class PerplexityResult:
    available: bool
    model: str
    mean_surprisal: float = 0.0
    surprisal_cv: float = 0.0
    perplexity: float = 0.0
    token_count: int = 0
    signal: float = 0.5
    reason: str = ""

    def as_dict(self) -> dict[str, object]:
        if not self.available:
            return {"available": False, "model": self.model, "reason": self.reason}
        return {
            "available": True,
            "model": self.model,
            "mean_surprisal": round(self.mean_surprisal, 4),
            "surprisal_cv": round(self.surprisal_cv, 4),
            "perplexity": round(self.perplexity, 3),
            "token_count": self.token_count,
            "signal": round(self.signal, 4),
        }


class _Backend:
    """Holds the tokenizer/model pair; created once per process."""

    def __init__(self, model_name: str):
        import torch  # noqa: F401  (imported for side effects / availability check)
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.model_name = model_name
        self.tokenizer = AutoTokenizer.from_pretrained(model_name)
        self.model = AutoModelForCausalLM.from_pretrained(model_name)
        self.model.eval()

    def score(self, text: str) -> PerplexityResult:
        import torch

        encoded = self.tokenizer(text, return_tensors="pt", truncation=True, max_length=MAX_TOKENS)
        input_ids = encoded["input_ids"]
        if input_ids.shape[1] < 8:
            return PerplexityResult(
                available=False,
                model=self.model_name,
                reason="Input is shorter than 8 tokens.",
            )

        with torch.no_grad():
            logits = self.model(**encoded).logits

        shifted_logits = logits[:, :-1, :]
        targets = input_ids[:, 1:]
        log_probs = torch.log_softmax(shifted_logits, dim=-1)
        token_logprobs = log_probs.gather(2, targets.unsqueeze(-1)).squeeze(-1)[0]
        surprisal = (-token_logprobs).tolist()

        mean = sum(surprisal) / len(surprisal)
        variance = sum((s - mean) ** 2 for s in surprisal) / len(surprisal)
        cv = (variance**0.5) / mean if mean > 0 else 0.0

        return PerplexityResult(
            available=True,
            model=self.model_name,
            mean_surprisal=mean,
            surprisal_cv=cv,
            perplexity=float(pow(2.718281828459045, mean)),
            token_count=len(surprisal),
            signal=_to_signal(mean, cv),
        )


def _interpolate(value: float, human: float, model: float) -> float:
    """Map a measurement onto 0 (human-like) .. 1 (model-like)."""
    if human == model:
        return 0.5
    ratio = (human - value) / (human - model)
    return max(0.0, min(1.0, ratio))


def _to_signal(mean_surprisal: float, cv: float) -> float:
    surprisal_component = _interpolate(mean_surprisal, SURPRISAL_HUMAN, SURPRISAL_MODEL)
    burstiness_component = _interpolate(cv, CV_HUMAN, CV_MODEL)
    return 0.65 * surprisal_component + 0.35 * burstiness_component


def is_enabled() -> bool:
    return os.environ.get("TPL_ENABLE_PERPLEXITY", "0").lower() in {"1", "true", "yes"}


def _get_backend() -> _Backend | None:
    global _loaded, _load_failed
    if _loaded is not None:
        return _loaded
    if _load_failed:
        return None
    with _lock:
        if _loaded is not None:
            return _loaded
        try:
            _loaded = _Backend(DEFAULT_MODEL)
        except Exception as exc:  # pragma: no cover - depends on optional deps
            logger.warning("Perplexity backend unavailable: %s", exc)
            _load_failed = True
            return None
    return _loaded


def analyse(text: str) -> PerplexityResult:
    """Score ``text``; never raises."""
    if not is_enabled():
        return PerplexityResult(
            available=False,
            model=DEFAULT_MODEL,
            reason="Disabled (set TPL_ENABLE_PERPLEXITY=1 to enable).",
        )
    backend = _get_backend()
    if backend is None:
        return PerplexityResult(
            available=False,
            model=DEFAULT_MODEL,
            reason="transformers/torch not installed or the model could not be loaded.",
        )
    try:
        return backend.score(text)
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("Perplexity scoring failed")
        return PerplexityResult(available=False, model=DEFAULT_MODEL, reason=str(exc))


def warmup() -> bool:
    """Preload the backend so the first request is not slow."""
    return is_enabled() and _get_backend() is not None


__all__ = ["PerplexityResult", "analyse", "is_enabled", "warmup"]
