"""Surface-style profiles for common generator families.

This module answers "which *house style* does this text resemble?", not "which
model produced this text?". No public method can attribute text to a specific
vendor's model from the text alone, so every profile returned here carries
``speculative=True`` and a similarity capped well below certainty. The UI is
expected to present it as a stylistic resemblance, never as attribution.

Scoring
-------
A profile is a set of :class:`Trait` constraints. Most traits are monotone -
"more typos is more human-unedited", not "exactly this many typos" - so each
trait declares a direction:

``at_least``   only a shortfall below the target is penalised
``at_most``    only an excess above the target is penalised
``two_sided``  distance in either direction is penalised

The penalty is ``min(1, distance / tolerance)``, combined as a weighted mean.
Similarity is ``1 - penalty``. Keeping the arithmetic this plain means a
surprising ranking can always be traced back to one trait.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .features import FeatureSet

DISCLAIMER = (
    "Stylistic resemblance only. These profiles describe formatting and register "
    "habits, not authorship; they cannot identify which system produced a text."
)

AT_LEAST = "at_least"
AT_MOST = "at_most"
TWO_SIDED = "two_sided"

#: Similarity can never exceed this - the method does not justify certainty.
MAX_SIMILARITY = 0.85


@dataclass(frozen=True)
class Trait:
    name: str
    target: float
    tolerance: float
    direction: str = TWO_SIDED
    weight: float = 1.0
    #: Restrict the trait to specific languages (e.g. English contractions).
    languages: tuple[str, ...] | None = None

    def penalty(self, observed: float) -> float:
        if self.direction == AT_LEAST:
            distance = max(0.0, self.target - observed)
        elif self.direction == AT_MOST:
            distance = max(0.0, observed - self.target)
        else:
            distance = abs(observed - self.target)
        return min(1.0, distance / max(self.tolerance, 1e-6))


@dataclass(frozen=True)
class Profile:
    family: str
    label: str
    traits: tuple[Trait, ...]
    rationale: str


PROFILES: tuple[Profile, ...] = (
    Profile(
        family="structured_assistant",
        label="Structured assistant output (bulleted, headed answer)",
        traits=(
            Trait("bullet_line_ratio", 0.30, 0.30, AT_LEAST, 2.0),
            Trait("bold_run_rate", 0.15, 0.35, AT_LEAST, 1.0),
            Trait("sentence_length_cv", 0.55, 0.35, AT_MOST, 1.0),
            Trait("discourse_marker_rate", 0.60, 1.00, AT_LEAST, 1.0),
            Trait("opening_pleasantry", 1.00, 1.00, AT_LEAST, 0.5),
        ),
        rationale="Dense lists, bold key terms and a summarising closing paragraph.",
    ),
    Profile(
        family="prose_assistant",
        label="Prose assistant output (flowing paragraphs, few lists)",
        traits=(
            Trait("bullet_line_ratio", 0.08, 0.15, AT_MOST, 1.5),
            Trait("mean_sentence_length", 18.0, 8.0, AT_LEAST, 1.0),
            Trait("sentence_length_cv", 0.50, 0.30, AT_MOST, 1.5),
            Trait("typo_indicator_rate", 0.80, 1.20, AT_MOST, 1.5),
            Trait("discourse_marker_rate", 0.50, 0.90, AT_LEAST, 1.0),
            Trait("contraction_rate", 1.50, 2.50, AT_MOST, 0.5, languages=("en",)),
        ),
        rationale="Long, evenly paced paragraphs with explicit connectives and no slips.",
    ),
    Profile(
        family="marketing_copy",
        label="Generated marketing / SEO copy",
        traits=(
            Trait("assistant_lexicon_rate", 1.20, 1.40, AT_LEAST, 2.0),
            Trait("exclamation_rate", 0.80, 1.50, AT_LEAST, 1.0),
            Trait("mean_sentence_length", 15.0, 7.0, AT_MOST, 1.0),
            Trait("sentence_start_repetition", 0.25, 0.30, AT_LEAST, 1.0),
        ),
        rationale="Superlative vocabulary, short punchy sentences, repeated openings.",
    ),
    Profile(
        family="human_unedited",
        label="Unedited human writing",
        traits=(
            Trait("typo_indicator_rate", 1.50, 1.80, AT_LEAST, 1.5),
            Trait("sentence_length_cv", 0.55, 0.35, AT_LEAST, 1.0),
            Trait("personal_pronoun_rate", 2.00, 3.00, AT_LEAST, 1.0),
            Trait("curly_quote_ratio", 0.20, 0.30, AT_MOST, 0.5),
            Trait("bullet_line_ratio", 0.10, 0.25, AT_MOST, 0.5),
            Trait("contraction_rate", 1.50, 2.50, AT_LEAST, 1.0, languages=("en",)),
        ),
        rationale="Spacing slips, contractions, first-person voice and variable sentence length.",
    ),
    Profile(
        family="human_edited",
        label="Edited / published human writing",
        traits=(
            Trait("typo_indicator_rate", 0.60, 0.80, AT_MOST, 1.0),
            Trait("sentence_length_cv", 0.55, 0.30, AT_LEAST, 1.5),
            Trait("curly_quote_ratio", 0.50, 0.50, AT_LEAST, 0.75),
            Trait("bullet_line_ratio", 0.10, 0.25, AT_MOST, 0.5),
            Trait("assistant_lexicon_rate", 0.50, 0.80, AT_MOST, 1.0),
            Trait("discourse_marker_rate", 0.60, 0.90, AT_MOST, 1.0),
        ),
        rationale="Typographic punctuation and clean spacing, but human sentence rhythm.",
    ),
)

_BOLD_RE = re.compile(r"\*\*[^*\n]+\*\*")
_OPENING_PLEASANTRY_RE = re.compile(
    r"^\s*(certainly|sure|of course|great question|absolutely|happy to help|"
    r"oczywiście|jasne|świetne pytanie|z przyjemnością)\b[!,.]",
    re.IGNORECASE,
)


def surface_traits(text: str, features: FeatureSet) -> dict[str, float]:
    """Feature values plus the layout traits only the raw text can provide."""
    lines = [line for line in text.splitlines() if line.strip()] or [""]
    traits = dict(features.values)
    traits["bold_run_rate"] = len(_BOLD_RE.findall(text)) / len(lines)
    traits["opening_pleasantry"] = 1.0 if _OPENING_PLEASANTRY_RE.match(text) else 0.0
    return traits


def _similarity(traits: dict[str, float], profile: Profile, language: str) -> float:
    weighted_penalty = 0.0
    total_weight = 0.0
    for trait in profile.traits:
        if trait.languages and language not in trait.languages:
            continue
        observed = traits.get(trait.name)
        if observed is None:
            continue
        weighted_penalty += trait.penalty(observed) * trait.weight
        total_weight += trait.weight
    if total_weight == 0:
        return 0.0
    return max(0.0, 1.0 - weighted_penalty / total_weight)


def profile_text(text: str, features: FeatureSet, limit: int = 3) -> list[dict[str, object]]:
    """Rank the style profiles that best match ``text``."""
    traits = surface_traits(text, features)
    scored = [
        {
            "family": profile.family,
            "label": profile.label,
            "similarity": round(
                min(MAX_SIMILARITY, _similarity(traits, profile, features.language)), 4
            ),
            "rationale": profile.rationale,
            "speculative": True,
        }
        for profile in PROFILES
    ]
    scored.sort(key=lambda item: -float(item["similarity"]))
    return scored[:limit]


__all__ = [
    "AT_LEAST",
    "AT_MOST",
    "DISCLAIMER",
    "MAX_SIMILARITY",
    "PROFILES",
    "Profile",
    "TWO_SIDED",
    "Trait",
    "profile_text",
    "surface_traits",
]
