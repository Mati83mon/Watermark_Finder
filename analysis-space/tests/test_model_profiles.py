from __future__ import annotations

from tpl.features import extract_features
from tpl.model_profiles import PROFILES, profile_text

BULLETED_ASSISTANT = """Certainly! Here's a comprehensive overview of bicycle maintenance.

**Key areas to inspect**

- **Drivetrain**: clean the chain regularly to ensure optimal performance.
- **Brakes**: inspect the pads and replace them when worn.
- **Tyres**: check the pressure before every ride.
- **Cables**: replace housing periodically to maintain shifting quality.

**Recommended schedule**

1. Weekly: tyre pressure and brake check.
2. Monthly: chain cleaning and lubrication.
3. Annually: a full service by a professional mechanic.

In summary, a structured maintenance routine is essential for safety and longevity."""

UNEDITED_HUMAN = """ok so I finally looked at the brakes today and honestly they're
worse than I thought. The pads are basically metal on metal at this point!! I
don't know how I didn't hear it.  Anyway I ordered new ones, they're supposed to
show up thursday. I'll probably mess it up the first time, I always do.

my brother says I should just take it to the shop but that's like 60 quid and
I'd rather learn. we'll see."""


def _top_family(text: str) -> str:
    features = extract_features(text)
    return profile_text(text, features)[0]["family"]


def test_bulleted_answer_matches_the_structured_profile():
    assert _top_family(BULLETED_ASSISTANT) == "structured_assistant"


def test_unedited_human_text_matches_a_human_profile():
    assert _top_family(UNEDITED_HUMAN).startswith("human")


def test_prose_assistant_beats_structured_for_paragraph_output(assistant_text):
    features = extract_features(assistant_text)
    ranked = {
        item["family"]: item["similarity"]
        for item in profile_text(assistant_text, features, limit=99)
    }
    assert ranked["prose_assistant"] > ranked["structured_assistant"]


def test_similarity_is_capped_and_flagged(assistant_text):
    matches = profile_text(assistant_text, extract_features(assistant_text))
    assert matches
    for match in matches:
        assert 0.0 <= match["similarity"] <= 0.85
        assert match["speculative"] is True
        assert match["rationale"]


def test_every_profile_is_reachable():
    families = {profile.family for profile in PROFILES}
    assert len(families) == len(PROFILES)


def test_conftest_human_sample_matches_a_human_profile(human_text):
    assert _top_family(human_text).startswith("human")


def test_trait_direction_is_one_sided():
    from tpl.model_profiles import AT_LEAST, AT_MOST, Trait

    at_least = Trait("x", 1.0, 1.0, AT_LEAST)
    assert at_least.penalty(5.0) == 0.0  # overshooting is fine
    assert at_least.penalty(0.5) == 0.5

    at_most = Trait("x", 1.0, 1.0, AT_MOST)
    assert at_most.penalty(0.0) == 0.0
    assert at_most.penalty(3.0) == 1.0  # clipped
