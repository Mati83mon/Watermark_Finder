"""Runtime configuration, read once from the environment.

Every value has a working default so the Space boots with no configuration at
all; the Worker-facing token is the only setting that should always be set in a
real deployment.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

VERSION = "1.0.0"
SCHEMA_VERSION = "1.0"


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_list(name: str, default: list[str]) -> list[str]:
    raw = os.environ.get(name)
    if not raw:
        return list(default)
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    #: Shared secret expected in the ``X-API-Key`` header. Empty means open.
    api_token: str = field(default_factory=lambda: os.environ.get("TPL_API_TOKEN", ""))
    #: Hard limit on the size of a single analysis request.
    max_chars: int = field(default_factory=lambda: _env_int("TPL_MAX_CHARS", 200_000))
    #: Hard limit on uploaded files handed to /extract.
    max_upload_bytes: int = field(
        default_factory=lambda: _env_int("TPL_MAX_UPLOAD_BYTES", 10 * 1024 * 1024)
    )
    #: Segmentation window size in words.
    window_words: int = field(default_factory=lambda: _env_int("TPL_WINDOW_WORDS", 120))
    window_overlap: int = field(default_factory=lambda: _env_int("TPL_WINDOW_OVERLAP", 30))
    #: Maximum number of segments returned to the caller.
    max_segments: int = field(default_factory=lambda: _env_int("TPL_MAX_SEGMENTS", 300))
    cors_origins: list[str] = field(default_factory=lambda: _env_list("TPL_CORS_ORIGINS", ["*"]))
    enable_gradio: bool = field(default_factory=lambda: _env_bool("TPL_ENABLE_GRADIO", False))
    enable_perplexity: bool = field(
        default_factory=lambda: _env_bool("TPL_ENABLE_PERPLEXITY", False)
    )
    log_level: str = field(default_factory=lambda: os.environ.get("TPL_LOG_LEVEL", "INFO"))
    port: int = field(default_factory=lambda: _env_int("PORT", 7860))


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings


def reset_settings() -> None:
    """Test hook: drop the cached settings so env changes take effect."""
    global _settings
    _settings = None


__all__ = ["SCHEMA_VERSION", "Settings", "VERSION", "get_settings", "reset_settings"]
