"""FastAPI application exposed by the Hugging Face Space.

Endpoints
---------
``GET  /health``       liveness probe used by the Worker and by CI.
``GET  /version``      engine version, active style model and its metrics.
``GET  /capabilities`` which optional features are actually available.
``POST /analyze``      the analysis itself.
``POST /extract``      turn an uploaded PDF/DOCX/HTML/TXT into plain text.

Authentication is a single shared secret in ``X-API-Key``. That is proportionate
here: the Worker is the only client, the Space stores nothing, and anything
stronger would need infrastructure the free tier does not provide.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any, Literal

from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .config import SCHEMA_VERSION, VERSION, get_settings
from .extraction import SUPPORTED_EXTENSIONS, ExtractionError, extract
from .llm_classifier import load_model, model_metrics
from .perplexity import is_enabled as perplexity_enabled
from .pipeline import AnalysisError, analyse

logger = logging.getLogger("tpl.api")


class AnalyzeRequest(BaseModel):
    text: str = Field(..., description="Raw document text, exactly as received.")
    mode: Literal["quick", "forensic"] = Field(
        "forensic", description="'quick' skips optional models and coarsens segmentation."
    )
    client_reference: str | None = Field(
        None,
        max_length=128,
        description="Opaque id echoed back in the response so the caller can correlate.",
    )


class AnalyzeResponse(BaseModel):
    request_id: str
    client_reference: str | None = None
    result: dict[str, Any]


class ErrorResponse(BaseModel):
    error: str
    detail: str
    request_id: str


def create_app() -> FastAPI:
    settings = get_settings()
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    app = FastAPI(
        title="text-provenance-lab",
        version=VERSION,
        description=(
            "Watermark and text-provenance analysis engine. Deterministic covert-channel "
            "detection plus probabilistic stylometry, running entirely on CPU with no "
            "external API calls."
        ),
        docs_url="/docs",
        openapi_url="/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-API-Key"],
    )

    def require_api_key(x_api_key: str = Header(default="")) -> None:
        expected = get_settings().api_token
        if not expected:
            return
        # Constant-time comparison keeps the token out of timing side channels.
        provided = x_api_key or ""
        if len(provided) != len(expected) or not _constant_time_equals(provided, expected):
            raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")

    @app.middleware("http")
    async def add_request_id(request: Request, call_next):
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        started = time.perf_counter()
        request.state.request_id = request_id
        response = await call_next(request)
        elapsed = (time.perf_counter() - started) * 1000
        response.headers["x-request-id"] = request_id
        response.headers["x-processing-ms"] = f"{elapsed:.1f}"
        logger.info(
            "%s %s -> %s in %.1fms (request_id=%s)",
            request.method,
            request.url.path,
            response.status_code,
            elapsed,
            request_id,
        )
        return response

    @app.exception_handler(AnalysisError)
    async def analysis_error_handler(request: Request, exc: AnalysisError):
        return JSONResponse(
            status_code=422,
            content={
                "error": "invalid_input",
                "detail": str(exc),
                "request_id": getattr(request.state, "request_id", ""),
            },
        )

    @app.exception_handler(ExtractionError)
    async def extraction_error_handler(request: Request, exc: ExtractionError):
        return JSONResponse(
            status_code=422,
            content={
                "error": "extraction_failed",
                "detail": str(exc),
                "request_id": getattr(request.state, "request_id", ""),
            },
        )

    @app.get("/health", tags=["meta"])
    async def health() -> dict[str, Any]:
        return {"status": "ok", "version": VERSION, "schema_version": SCHEMA_VERSION}

    @app.get("/version", tags=["meta"])
    async def version() -> dict[str, Any]:
        model = load_model()
        return {
            "engine": "text-provenance-lab",
            "version": VERSION,
            "schema_version": SCHEMA_VERSION,
            "style_model": {
                "id": model.model_id,
                "trained": model.trained,
                "metrics": model_metrics(),
            },
        }

    @app.get("/capabilities", tags=["meta"])
    async def capabilities() -> dict[str, Any]:
        settings = get_settings()
        return {
            "modes": ["quick", "forensic"],
            "max_chars": settings.max_chars,
            "max_upload_bytes": settings.max_upload_bytes,
            "perplexity_enabled": perplexity_enabled(),
            "supported_uploads": sorted(SUPPORTED_EXTENSIONS),
            "auth_required": bool(settings.api_token),
        }

    @app.post(
        "/analyze",
        response_model=AnalyzeResponse,
        responses={401: {"model": ErrorResponse}, 422: {"model": ErrorResponse}},
        tags=["analysis"],
        dependencies=[Depends(require_api_key)],
    )
    async def analyze(request: Request, payload: AnalyzeRequest) -> AnalyzeResponse:
        result = analyse(payload.text, payload.mode)
        return AnalyzeResponse(
            request_id=getattr(request.state, "request_id", ""),
            client_reference=payload.client_reference,
            result=result,
        )

    @app.post(
        "/extract",
        tags=["analysis"],
        dependencies=[Depends(require_api_key)],
        responses={401: {"model": ErrorResponse}, 422: {"model": ErrorResponse}},
    )
    async def extract_endpoint(request: Request, file: UploadFile = File(...)) -> dict[str, Any]:
        settings = get_settings()
        data = await file.read(settings.max_upload_bytes + 1)
        if len(data) > settings.max_upload_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"File exceeds the {settings.max_upload_bytes} byte limit",
            )
        result = extract(data, file.filename or "upload.txt", max_chars=settings.max_chars)
        return {
            "request_id": getattr(request.state, "request_id", ""),
            **result.as_dict(),
        }

    return app


def _constant_time_equals(left: str, right: str) -> bool:
    result = 0
    for a, b in zip(left, right, strict=False):
        result |= ord(a) ^ ord(b)
    return result == 0


__all__ = ["AnalyzeRequest", "AnalyzeResponse", "create_app"]
