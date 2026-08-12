# Architecture

## Shape of the system

```
                    browser
                       │
                       │  static assets
              ┌────────▼─────────┐
              │ Cloudflare Pages │   Next.js 14, static export
              │   (free tier)    │   no server-side rendering
              └────────┬─────────┘
                       │  fetch(), JSON over HTTPS
              ┌────────▼─────────┐
              │ Cloudflare Worker│   Hono + TypeScript
              │   (free tier)    │   auth, validation, rate limits, jobs
              └──┬────┬────┬──┬──┘
                 │    │    │  │
            ┌────▼┐ ┌─▼──┐ │  │ HTTPS
            │ D1  │ │ KV │ │  │
            └─────┘ └────┘ │  │
                      ┌────▼┐ │
                      │ R2  │ │
                      └─────┘ │
                    ┌─────────▼──────────┐
                    │ Hugging Face Space │   FastAPI, Python 3.11
                    │   (CPU Basic)      │   all analysis, no state
                    └────────────────────┘
```

No component is billed. No request leaves this diagram: the Space performs every
model computation locally and calls nothing outbound.

## Why the pieces are where they are

**Analysis in the Space, not the Worker.** The Worker free plan allows 10 ms of
CPU per invocation. Unicode scanning over a 200 kB document, twenty stylometric
features, per-segment classification and optional transformer inference are all
far past that. The Space has 2 vCPU and 16 GB with no per-request CPU cap, so all
computation lives there and the Worker only orchestrates. Time the Worker spends
*waiting* on the Space is I/O and does not count against its CPU budget.

**Static export, not `@cloudflare/next-on-pages`.** Nothing in the UI needs
server rendering: the browser holds the workspace token and fetches its own data.
A static export removes the adapter, the edge runtime constraints and a whole
class of build failures, and it makes the Pages deployment a plain file upload.

**Three stores, three jobs.**

| Store | Holds | Why not one of the others |
| --- | --- | --- |
| D1 | analyses, metrics, segments, reports, events | Needs `WHERE`, `ORDER BY`, `GROUP BY` and joins for lists and stats |
| R2 | submitted text, uploads, full result JSON | Result documents reach tens of kilobytes; blobs bloat rows and every list query |
| KV | result cache, rate-limit counters, capability cache | Reads at the edge with a TTL; nothing here is a source of truth |

Every R2 key is prefixed with the workspace id, so a mis-scoped read cannot cross
workspaces and a lifecycle rule can operate per workspace.

## Request flow

### Submitting an analysis

1. `POST /api/analyses` with either `text` or an `upload_id`.
2. The Worker checks the workspace token, the per-IP rate limit and the daily
   per-workspace analysis limit.
3. For an upload, the file is read from R2 and sent to the engine's `/extract`,
   which turns PDF/DOCX/HTML into text. PDF parsing never runs at the edge.
4. The text is hashed. An identical hash **and** mode already completed in this
   workspace returns the existing analysis with `deduplicated: true` — repeat
   submissions cost nothing.
5. Otherwise the text goes to R2, a `pending` row goes to D1, and the job is
   handed to `ctx.waitUntil()`. The client gets `202` with an id immediately.
6. The background job calls the engine, writes the result to R2, the summary to
   `analysis_metrics`, the segments to `analysis_segments`, and flips the row to
   `done`.

### When something goes wrong

Cloudflare Queues are not on the free plan, so durability comes from the database
plus a cron trigger:

- A failure with attempts remaining sets the row back to `pending` and records a
  `analysis.retry_scheduled` event. A cold Space must never permanently fail a
  job.
- A cron trigger every five minutes picks up rows that are `pending` past the
  stall threshold, or `running` for longer than twice the engine timeout, and
  runs them again.
- Once `attempts` reaches `MAX_ATTEMPTS` the row is failed with a readable
  message and an `analysis.abandoned` event.

Execution is therefore at-least-once. `runAnalysis` is written to tolerate that:
metrics are upserted, segments are deleted-and-reinserted in one batch, and the
result object is overwritten by key.

## Identity

There are no accounts. `POST /api/session` mints a random workspace id and
returns `<id>.<hmac>` signed with `SESSION_SECRET`. The browser stores it and
sends it as `Authorization: Bearer`. Verification is stateless.

This is a deliberate trade: no passwords, no email addresses, no personal data,
no third-party identity provider, nothing to breach — at the cost that losing the
token loses the history. The Settings page says so plainly.

## Data flow and retention

Submitted text is stored in R2 so results can be revisited and the heatmap can be
rendered. Deleting an analysis deletes its text, its result and its cache entry.
The engine stores nothing at all: it receives a string and returns JSON.

## Free-tier budget

| Limit | Free allowance | How the design stays inside it |
| --- | --- | --- |
| Worker requests | 100 k/day | Polling backs off from 1.2 s to 8 s; capabilities cached 5 min in KV |
| Worker CPU | 10 ms/request | No analysis at the edge; the Worker only routes and serialises |
| D1 rows read | 5 M/day | Every list query is index-backed; blobs live in R2 |
| D1 storage | 5 GB | Rows are summaries; documents are in R2 |
| KV reads | 100 k/day | Cache and counters only |
| R2 storage | 10 GB | Text plus JSON, a few kB per analysis |
| Space | CPU Basic, sleeps when idle | The UI shows "engine asleep"; the client retries with backoff |

`DAILY_ANALYSIS_LIMIT` caps how much any one workspace can spend of the shared
budget.

## Testing strategy

| Layer | Approach | Count |
| --- | --- | --- |
| Engine | pytest over pure functions and the FastAPI app via `TestClient` | 82 |
| Worker | vitest driving the real Hono app; D1 is real SQLite (`node:sqlite`) running the production migration; KV/R2 are in-memory doubles; the engine is a stub | 63 |
| Web | vitest + Testing Library over the API client, heatmap maths and components | 41 |
| Integration | `worker/test/e2e.manual.ts` drives the real Worker against the real Python engine, asserting a planted payload is recovered end to end | 24 checks |

The D1 harness runs `migrations/0001_init.sql` itself, so a schema change that
breaks a query fails the test suite rather than production.
