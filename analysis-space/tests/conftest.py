from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tpl.config import reset_settings  # noqa: E402
from tpl.llm_classifier import reset_model_cache  # noqa: E402

#: A human-sounding sample: varied sentence length, contractions, slips.
HUMAN_TEXT = """I finally got the old bike working again. Took three evenings.
The rear derailleur was bent - not badly, but enough that the chain kept
skipping under load, and I didn't notice until I was halfway up the hill behind
the station.  Anyway. New cable, a bit of filing, and it shifts fine now.

My neighbour watched the whole thing from his balcony and said nothing until I
was done, then told me the bike was his brother's in 1994. I don't know if
that's true! He tells a lot of stories. Either way it rides.

Next weekend I want to redo the brake pads. The front ones are basically gone,
you can see the metal, which is probably not great. I keep putting it off
because the last time I tried I rounded off a bolt and had to walk home."""

#: An assistant-sounding sample: uniform sentences, connectives, register words.
ASSISTANT_TEXT = """Maintaining a bicycle is a crucial aspect of ensuring both
safety and longevity. Regular maintenance not only extends the lifespan of the
components but also significantly improves the overall riding experience.
Moreover, a well-maintained bicycle is considerably safer to operate in urban
environments.

It is important to note that the drivetrain requires particular attention.
Furthermore, the derailleur should be inspected regularly to ensure optimal
shifting performance. Additionally, cables and housing should be replaced
periodically, as degradation can significantly impact performance.

In conclusion, a comprehensive maintenance routine is essential for any cyclist
seeking to leverage the full potential of their equipment. By fostering good
habits, riders can navigate the complexities of bicycle upkeep seamlessly."""

POLISH_TEXT = """Rower to środek transportu, który wymaga regularnej konserwacji.
Przede wszystkim należy zwrócić uwagę na układ napędowy, ponieważ to on decyduje
o komforcie jazdy. Ponadto warto zauważyć, że przerzutki wymagają okresowej
regulacji, co pozwala zachować precyzję zmiany biegów.

Podsumowując, kompleksowa konserwacja stanowi kluczowy element bezpieczeństwa.
Dzięki temu można skutecznie wykorzystać pełen potencjał sprzętu."""


@pytest.fixture(autouse=True)
def _clean_state():
    reset_settings()
    reset_model_cache()
    yield
    reset_settings()
    reset_model_cache()


@pytest.fixture
def human_text() -> str:
    return HUMAN_TEXT


@pytest.fixture
def assistant_text() -> str:
    return ASSISTANT_TEXT


@pytest.fixture
def polish_text() -> str:
    return POLISH_TEXT
