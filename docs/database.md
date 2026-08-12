# Database schema (D1 / SQLite)

Source of truth: [`worker/migrations/0001_init.sql`](../worker/migrations/0001_init.sql).
The test harness runs that exact file against in-memory SQLite, so a schema
change that breaks a query fails CI.

## Conventions

- Ids are time-sortable strings (`newId()` in `worker/src/lib/crypto.ts`), so
  `ORDER BY created_at DESC` and `ORDER BY id DESC` agree.
- Timestamps are epoch milliseconds as `INTEGER`.
- Booleans are `INTEGER` 0/1.
- Deletes cascade from `analyses` and `workspaces`.
- Large documents live in R2 and are referenced by key; no blob columns.

## Tables

### `workspaces`

Anonymous namespaces. Contains no personal data.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | Issued by `POST /api/session` |
| `created_at` | INTEGER | |
| `last_seen_at` | INTEGER | Touched on every authenticated request |

### `analyses`

One row per submission.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | |
| `workspace_id` | TEXT FK | → `workspaces.id`, cascade |
| `status` | TEXT | `pending` \| `running` \| `done` \| `error` (CHECK) |
| `mode` | TEXT | `quick` \| `forensic` (CHECK) |
| `source` | TEXT | `text` \| `file` (CHECK) |
| `filename` | TEXT | Sanitised; null for pasted text |
| `r2_text_key` | TEXT | `texts/<workspace>/<id>.txt` |
| `r2_result_key` | TEXT | `results/<workspace>/<id>.json`, set on completion |
| `text_sha256` | TEXT | Drives deduplication |
| `char_count` | INTEGER | |
| `attempts` | INTEGER | Incremented by `markRunning`; bounded by `MAX_ATTEMPTS` |
| `engine_version` | TEXT | Which engine produced the result |
| `error` | TEXT | Set only on terminal failure |
| `created_at` / `started_at` / `completed_at` | INTEGER | |

Indexes:

| Index | Serves |
| --- | --- |
| `idx_analyses_workspace_created` | The list view and the dashboard |
| `idx_analyses_status_created` | The cron sweep for stalled jobs |
| `idx_analyses_workspace_hash` | Deduplication lookup by `(workspace, sha256, mode)` |

### `analysis_metrics`

Denormalised headline numbers so list views never touch R2.

| Column | Type |
| --- | --- |
| `analysis_id` | TEXT PK FK |
| `risk_score` / `risk_label` | REAL / TEXT |
| `watermark_score` / `watermark_label` | REAL / TEXT |
| `llm_score` / `llm_low` / `llm_high` / `llm_label` | REAL / TEXT |
| `llm_model_id` / `llm_trained` | TEXT / INTEGER |
| `language` / `word_count` | TEXT / INTEGER |
| `payload_count` / `signal_count` | INTEGER |
| `created_at` | INTEGER |

Written with `INSERT … ON CONFLICT DO UPDATE`, so a retried job overwrites rather
than duplicating. `llm_low`/`llm_high` are stored alongside the point estimate so
a list view can show the uncertainty band without loading the result document.

### `analysis_segments`

Per-window scores, primary key `(analysis_id, idx)`. Replaced wholesale inside a
single `db.batch()` transaction on each run, which keeps a retry idempotent.

`start_offset` / `end_offset` are character offsets into the submitted text.

### `reports`

User-saved analyses: `id`, `workspace_id`, `analysis_id`, `title`, `notes`,
`created_at`, indexed by `(workspace_id, created_at DESC)`.

### `events`

Append-only operational log: `analysis.created`, `analysis.completed`,
`analysis.retry_scheduled`, `analysis.failed`, `analysis.abandoned`,
`analysis.deduplicated`, `analysis.deleted`, `upload.created`, `report.created`,
`report.deleted`.

This is the first place to look when a job misbehaves:

```sql
SELECT created_at, type, detail FROM events
WHERE analysis_id = ?1 ORDER BY created_at;
```

## Storage budget

D1's free tier is 5 GB and 5 M row reads per day. Rows here are small — a
completed analysis is roughly 400 bytes across `analyses` and `analysis_metrics`,
plus about 150 bytes per segment. A 200 kB document produces at most 300
segments, so ~45 kB of segment rows in the worst case. The document itself and
its result JSON are in R2.

## Operations

```bash
# Apply migrations
npx wrangler d1 migrations apply watermark-finder --local
npx wrangler d1 migrations apply watermark-finder --remote

# Inspect
npx wrangler d1 execute watermark-finder --remote \
  --command "SELECT status, COUNT(*) FROM analyses GROUP BY status"

# Recent failures with their event trail
npx wrangler d1 execute watermark-finder --remote --command "
  SELECT a.id, a.attempts, a.error, e.type, e.detail
  FROM analyses a LEFT JOIN events e ON e.analysis_id = a.id
  WHERE a.status = 'error' ORDER BY a.created_at DESC LIMIT 20"
```

## Adding a migration

1. Add `worker/migrations/000N_description.sql`. Never edit an applied file.
2. Update the affected queries in `worker/src/lib/db.ts` and the types in
   `shared/src/index.ts`.
3. Run `npm test --workspace @wf/worker`; the harness applies migrations from
   disk, so a mismatch surfaces immediately.
4. Apply locally, then remotely. The deploy workflow applies migrations before
   the Worker is published, so the new code never meets the old schema.
