"""Word lists used for language detection and stylometric features.

The lists are intentionally small and auditable. Every entry earns its place by
being either (a) a high-frequency function word useful for language
identification, or (b) a marker whose relative frequency differs measurably
between edited human prose and unedited assistant output.

Nothing here identifies a specific vendor's model. The markers describe a
*register* - the explanatory, evenly-hedged style that instruction-tuned models
default to - which is why the classifier reports a style score rather than an
authorship verdict.
"""

from __future__ import annotations

# --------------------------------------------------------------------------
# Language identification
# --------------------------------------------------------------------------
STOPWORDS: dict[str, frozenset[str]] = {
    "en": frozenset(
        """the of and to in a is that it for on with as was be by this are at from
        or an but not have has had they you we he she his her its their our your
        which who what when where how all can will would should could there been
        more than into about over after before between while some such other""".split()
    ),
    "pl": frozenset(
        """i w z na do nie że się jest to a o jak po dla od przez ale czy tym te
        ten ta tego przy oraz już tylko może być są była był było były można
        gdy który która które których jego jej ich nasz wasz bardzo także jednak
        wtedy ponieważ dlatego wszystko każdy kiedy gdzie""".split()
    ),
    "de": frozenset(
        """der die das und ist ich nicht sie mit den von zu für auf ein eine als
        auch es an werden aus dem sich bei einer war haben nach wird wenn nur""".split()
    ),
    "es": frozenset(
        """el la de que y en los del se las por un para con no una su al lo como
        más pero sus le ya o este sí porque esta entre cuando muy sin sobre""".split()
    ),
    "fr": frozenset(
        """le de un et être avoir que pour dans ce il qui ne sur se pas plus par
        je avec tout faire son mettre autre on mais nous comme ou si leur""".split()
    ),
}

#: Characters that are strong evidence for a specific language.
LANGUAGE_HINT_CHARS: dict[str, frozenset[str]] = {
    "pl": frozenset("ąćęłńóśźż"),
    "de": frozenset("äöüß"),
    "es": frozenset("ñ¿¡"),
    "fr": frozenset("àâçéèêëîïôùûœ"),
}

# --------------------------------------------------------------------------
# Stylometric markers
# --------------------------------------------------------------------------
#: Connectives that assistant prose over-uses relative to edited human writing.
DISCOURSE_MARKERS: dict[str, frozenset[str]] = {
    "en": frozenset(
        [
            "moreover",
            "furthermore",
            "additionally",
            "consequently",
            "therefore",
            "however",
            "nevertheless",
            "nonetheless",
            "in conclusion",
            "in summary",
            "to summarize",
            "overall",
            "importantly",
            "notably",
            "specifically",
            "in essence",
            "that said",
            "on the other hand",
            "first and foremost",
            "it is worth noting",
            "it's worth noting",
            "it is important to note",
            "it's important to note",
            "keep in mind",
            "as a result",
            "in other words",
            "by contrast",
            "ultimately",
        ]
    ),
    "pl": frozenset(
        [
            "ponadto",
            "co więcej",
            "dodatkowo",
            "w rezultacie",
            "w konsekwencji",
            "dlatego też",
            "jednakże",
            "niemniej jednak",
            "podsumowując",
            "reasumując",
            "warto zauważyć",
            "warto podkreślić",
            "należy pamiętać",
            "należy zauważyć",
            "z drugiej strony",
            "przede wszystkim",
            "innymi słowy",
            "w istocie",
            "ostatecznie",
            "kluczowe jest",
        ]
    ),
}

#: Vocabulary that is disproportionately frequent in assistant output.
ASSISTANT_LEXICON: dict[str, frozenset[str]] = {
    "en": frozenset(
        [
            "delve",
            "delving",
            "tapestry",
            "realm",
            "landscape",
            "underscore",
            "underscores",
            "pivotal",
            "crucial",
            "robust",
            "seamless",
            "seamlessly",
            "leverage",
            "leveraging",
            "harness",
            "navigate",
            "navigating",
            "foster",
            "fostering",
            "holistic",
            "nuanced",
            "multifaceted",
            "comprehensive",
            "intricate",
            "vibrant",
            "testament",
            "unlock",
            "unlocking",
            "elevate",
            "embark",
            "cornerstone",
            "paradigm",
            "synergy",
            "streamline",
            "streamlined",
            "empower",
            "empowering",
            "transformative",
            "myriad",
            "plethora",
            "meticulous",
            "meticulously",
        ]
    ),
    "pl": frozenset(
        [
            "kluczowy",
            "kluczowe",
            "kluczowym",
            "istotny",
            "istotne",
            "znaczący",
            "znacząco",
            "kompleksowy",
            "kompleksowe",
            "holistyczny",
            "wszechstronny",
            "innowacyjny",
            "dynamiczny",
            "efektywnie",
            "skutecznie",
            "umożliwia",
            "pozwala",
            "stanowi",
            "wykorzystać",
            "wykorzystanie",
            "zapewnia",
            "niezwykle",
            "fundamentalny",
            "przełomowy",
            "zoptymalizować",
            "usprawnić",
        ]
    ),
}

#: Hedges and disclaimers typical of instruction-tuned assistants.
HEDGE_MARKERS: dict[str, frozenset[str]] = {
    "en": frozenset(
        [
            "it depends",
            "generally speaking",
            "in general",
            "typically",
            "often",
            "may vary",
            "can vary",
            "it is recommended",
            "it's recommended",
            "consider consulting",
            "as an ai",
            "i cannot",
            "i can't provide",
            "please note",
            "note that",
            "keep in mind that",
        ]
    ),
    "pl": frozenset(
        [
            "to zależy",
            "ogólnie rzecz biorąc",
            "zazwyczaj",
            "zwykle",
            "może się różnić",
            "zaleca się",
            "warto skonsultować",
            "należy pamiętać, że",
            "zwróć uwagę",
            "jako sztuczna inteligencja",
        ]
    ),
}

#: English contractions - a fast proxy for informal, human-edited register.
CONTRACTIONS: frozenset[str] = frozenset(
    [
        "don't",
        "doesn't",
        "didn't",
        "can't",
        "won't",
        "isn't",
        "aren't",
        "wasn't",
        "weren't",
        "haven't",
        "hasn't",
        "hadn't",
        "i'm",
        "i've",
        "i'd",
        "i'll",
        "you're",
        "you've",
        "you'll",
        "we're",
        "we've",
        "they're",
        "they've",
        "it's",
        "that's",
        "there's",
        "let's",
        "he's",
        "she's",
        "wouldn't",
        "shouldn't",
        "couldn't",
        "ain't",
        "gonna",
        "wanna",
    ]
)


def markers_for(table: dict[str, frozenset[str]], language: str) -> frozenset[str]:
    """Return the marker set for ``language`` with an English fallback."""
    return table.get(language) or table.get("en", frozenset())


__all__ = [
    "ASSISTANT_LEXICON",
    "CONTRACTIONS",
    "DISCOURSE_MARKERS",
    "HEDGE_MARKERS",
    "LANGUAGE_HINT_CHARS",
    "STOPWORDS",
    "markers_for",
]
