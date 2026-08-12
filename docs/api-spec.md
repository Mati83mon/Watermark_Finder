# API specification

Two HTTP surfaces:

- **Worker API** — what the browser talks to. Base: the deployed Worker URL.
- **Engine API** — what the Worker talks to. Base: the Space URL.

All bodies are JSON unless stated. All timestamps are epoch milliseconds.

---

## Worker API

### Authentication

Every route under `/api/analyses`, `/api/uploads` and `/api/reports` requires a
workspace token:

```
Authorization: Bearer <workspace-id>.<hmac>
```

`/api/health`, `/api/capabilities` and `/api/session` are public.

### Errors

Any non-2xx response has this shape:

```json
{
  "error": "rate_limited",
  "message": "Rate limit exceeded: 60 requests per 60s. Retry in 43s.",
  "request_id": "0f3k2j...",
  "details": { "retry_after_seconds": 43 }
}
```

| Code | Status | Meaning |
| --- | --- | --- |
| `bad_request` | 400 | Malformed or contradictory input |
| `unauthorized` | 401 | Missing, malformed or forged workspace token |
| `not_found` | 404 | No such resource *in this workspace* |
| `payload_too_large` | 413 | Text or upload over the configured limit |
| `rate_limited` | 429 | Per-IP or per-workspace limit hit; see `details` |
| `internal_error` | 500 | Unhandled failure; `request_id` appears in the logs |
| `engine_unavailable` | 502 | The analysis engine could not be reached or rejected the call |

Every response carries `x-request-id`. Rate-limited routes also return
`x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset`.

---

### `POST /api/session`

Mint an anonymous workspace. No body.

```json
{ "workspace_id": "w0k3n8...", "token": "w0k3n8....dGhpcy1p...", "created_at": 1760000000000 }
```

→ `201`

### `GET /api/health`

```json
{
  "status": "ok",
  "environment": "production",
  "checks": {
    "database": "ok",
    "engine": "ok",
    "engine_version": "1.0.0",
    "engine_detail": null
  },
  "warnings": [],
  "latency_ms": 212
}
```

→ `200` when the database and the engine both answer, `503` otherwise. A `503`
here usually means the free Space is asleep, not that anything is broken.

### `GET /api/capabilities`

Engine limits intersected with the Worker's own, cached 5 minutes in KV.

```json
{
  "modes": ["quick", "forensic"],
  "max_chars": 200000,
  "max_upload_bytes": 10485760,
  "supported_uploads": [".txt", ".md", ".pdf", ".docx", ".html", ".json"],
  "perplexity_enabled": false,
  "engine_version": "1.0.0",
  "engine_reachable": true
}
```

When the engine is unreachable this still returns `200` with
`engine_reachable: false` and the Worker's own limits, so the UI can render.

### `POST /api/analyses`

```json
{ "text": "the document…", "mode": "forensic" }
```
or
```json
{ "upload_id": "u0k3n8…", "mode": "quick" }
```

Exactly one of `text` and `upload_id`. `mode` defaults to `forensic`.

→ `202` with an `AnalysisSummary` whose `status` is `pending`.

→ `200` with `"deduplicated": true` when identical text has already been analysed
in this workspace in the same mode; the existing analysis is returned.

### `GET /api/analyses`

Query: `limit` (1–100, default 20), `offset` (≥0), `status`
(`pending|running|done|error`).

```json
{ "items": [ /* AnalysisSummary */ ], "total": 42, "limit": 20, "offset": 0 }
```

### `GET /api/analyses/:id`

Query: `include_result=false` to omit the full result document.

```jsonc
{
  "id": "a0k3n8…",
  "status": "done",
  "mode": "forensic",
  "source": "text",
  "filename": null,
  "char_count": 4820,
  "word_count": 812,
  "language": "en",
  "risk_score": 0.93, "risk_label": "critical",
  "watermark_score": 0.98, "watermark_label": "payload_recovered",
  "llm_score": 0.71, "llm_label": "likely_ai",
  "error": null,
  "created_at": 1760000000000,
  "completed_at": 1760000004120,
  "text_sha256": "…",
  "attempts": 1,
  "engine_version": "1.0.0",
  "result": { /* AnalysisResult, see below */ }
}
```

### `GET /api/analyses/:id/segments`

`{ "items": [ /* Segment */ ] }` — read from D1, no R2 access.

### `GET /api/analyses/:id/text`

`{ "id": "…", "text": "…", "sha256": "…" }` — the exact bytes submitted,
including any invisible characters. This is what the heatmap renders.

### `DELETE /api/analyses/:id`

Deletes the row, its metrics, its segments, its stored text, its result document
and its cache entry. → `{ "deleted": true, "id": "…" }`

### `POST /api/uploads`

`multipart/form-data` with a `file` field. Accepted extensions come from
`/api/capabilities`.

→ `201 { "upload_id": "u…", "filename": "report.pdf", "size": 91234, "content_type": "application/pdf" }`

Pass `upload_id` to `POST /api/analyses`. Text extraction happens in the engine.

### Reports

| Method | Path | Body / result |
| --- | --- | --- |
| `POST` | `/api/reports` | `{ "analysis_id", "title", "notes"? }` → `201` `Report`. The analysis must be `done`. |
| `GET` | `/api/reports` | `Paginated<Report>` |
| `GET` | `/api/reports/:id` | `Report` plus the embedded analysis and its result |
| `DELETE` | `/api/reports/:id` | `{ "deleted": true }` |

### `GET /api/stats`

```json
{
  "total": 42,
  "by_status": { "pending": 0, "running": 1, "done": 40, "error": 1 },
  "watermarks_detected": 7,
  "payloads_recovered": 3,
  "average_risk": 0.31,
  "last_7_days": [{ "date": "2026-08-06", "count": 4 }]
}
```

---

## Engine API

Authenticated with `X-API-Key: <TPL_API_TOKEN>` when the token is configured.

### `POST /analyze`

```json
{ "text": "…", "mode": "forensic", "client_reference": "a0k3n8…" }
```

→ `200 { "request_id": "…", "client_reference": "…", "result": AnalysisResult }`

→ `422` for empty text, text over `TPL_MAX_CHARS`, or an unknown mode.

### `POST /extract`

`multipart/form-data` with `file`.

→ `200 { "text": "…", "format": "pdf", "pages": 12, "truncated": false, "notes": [], "chars": 40213 }`

→ `413` over `TPL_MAX_UPLOAD_BYTES`, `422` when no text can be extracted.

### `GET /health`, `GET /version`, `GET /capabilities`, `GET /docs`

`/version` reports the active style model and, when one was trained, its
cross-validated metrics.

---

## `AnalysisResult`

The engine's full response. TypeScript definitions live in
[`shared/src/index.ts`](../shared/src/index.ts).

```jsonc
{
  "schema_version": "1.0",
  "engine": {
    "name": "text-provenance-lab", "version": "1.0.0", "mode": "forensic",
    "style_model": "prior-logistic-v1", "style_model_trained": false
  },
  "input": {
    "chars": 4820, "words": 812, "sentences": 41, "paragraphs": 6,
    "language": "en", "scripts": { "LATIN": 3980 }, "sha256": "…"
  },
  "scores": {
    // Probabilistic. Register, not authorship. `low`/`high` widen on short text.
    "llm_likelihood": {
      "value": 0.71, "low": 0.58, "high": 0.84,
      "label": "likely_ai", "confidence": "medium",
      "model_id": "prior-logistic-v1", "trained": false,
      "contributions": [
        { "feature": "sentence_length_cv", "value": 0.31, "z": -1.33,
          "contribution": 0.51, "direction": "assistant",
          "rationale": "Human prose alternates short and long sentences…" }
      ],
      "notes": ["Coefficients are a documented prior, not parameters fitted to a labelled corpus."]
    },
    // Deterministic. A fact about the bytes.
    "watermark": { "value": 0.98, "label": "payload_recovered", "confidence": "high" },
    "risk": { "value": 0.93, "label": "critical" }
  },
  "signals": [
    { "id": "invisible_characters", "category": "covert_channel",
      "title": "…", "description": "…", "score": 0.88, "weight": 1.0,
      "severity": "critical",
      "evidence": [{ "kind": "char", "detail": "U+200B ZERO WIDTH SPACE near: …",
                     "offset": 1420, "length": 1 }],
      "evidence_total": 37 }
  ],
  "payloads": [
    { "channel": "tag_characters", "text": "wm:demo-1", "byte_length": 9,
      "printable_ratio": 1.0, "carrier_count": 9,
      "first_offset": 31, "last_offset": 39, "note": "Unicode tag block (U+E0000-U+E007F)" }
  ],
  "segments": [
    { "index": 0, "start": 0, "end": 612, "word_count": 118, "preview": "…",
      "llm_likelihood": 0.74, "label": "leaning_assistant", "watermark_hits": 9 }
  ],
  "style_profiles": {
    "disclaimer": "Stylistic resemblance only…",
    "matches": [{ "family": "prose_assistant", "label": "…", "similarity": 0.62,
                  "rationale": "…", "speculative": true }]
  },
  "features": { "values": { "mattr": 0.71 }, "docs": { "mattr": "…" } },
  "perplexity": { "available": false, "reason": "Disabled (set TPL_ENABLE_PERPLEXITY=1 to enable)." },
  "findings": [
    { "id": "payload-tag_characters", "severity": "critical", "title": "…",
      "detail": "…", "recommendation": "…" }
  ],
  "technical_report_markdown": "# Text provenance report…",
  "warnings": ["Fewer than 40 words: treat every probabilistic score as indicative only."],
  "timings_ms": { "preprocess": 1.2, "features": 4.6, "watermarks": 0.9,
                  "classifier": 0.1, "segments": 12.4, "report": 0.8, "total": 21.6 },
  "model_metrics": {}
}
```

### Segment offsets

`start` and `end` are character offsets into **the exact text that was
submitted** — the same bytes `GET /api/analyses/:id/text` returns. No offset
translation is needed to highlight a fragment.

Segments overlap by design (sliding windows). `web/lib/heatmap.ts` cuts them into
non-overlapping fragments for rendering; the concatenated fragments equal the
source text exactly.

### Labels

| Field | Values |
| --- | --- |
| `scores.watermark.label` | `payload_recovered`, `watermark_detected`, `watermark_suspected`, `weak_indicators`, `clean` |
| `scores.llm_likelihood.label` | `insufficient_evidence`, `likely_human`, `inconclusive`, `likely_ai`, `very_likely_ai` |
| `scores.risk.label` | `minimal`, `low`, `medium`, `high`, `critical` |
| `segments[].label` | `human`, `leaning_human`, `mixed`, `leaning_assistant`, `assistant` |
| `signals[].category` | `covert_channel`, `obfuscation`, `stylistic` |
| `*.severity` | `info`, `low`, `medium`, `high`, `critical` |

### Versioning

`schema_version` is `"1.0"`. A breaking change to the payload increments it and
updates `shared/src/index.ts` in the same commit.
