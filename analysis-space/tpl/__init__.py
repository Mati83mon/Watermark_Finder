"""text-provenance-lab: watermark and text-provenance analysis engine.

Public surface:

- :func:`tpl.pipeline.analyse` - run the whole analysis over a string.
- :func:`tpl.api.create_app` - build the FastAPI application.
- :mod:`tpl.preprocessing` - Unicode scanning and covert-channel decoders.
- :mod:`tpl.watermark_heuristics` - watermark signal scoring.
- :mod:`tpl.features` / :mod:`tpl.llm_classifier` - stylometry.
"""

from .config import SCHEMA_VERSION, VERSION

__all__ = ["SCHEMA_VERSION", "VERSION"]
__version__ = VERSION
