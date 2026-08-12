-- Watermark Finder - initial D1 schema.
--
-- Apply with:
--   wrangler d1 migrations apply watermark-finder --local
--   wrangler d1 migrations apply watermark-finder --remote
--
-- Design notes
--   * Timestamps are epoch milliseconds (INTEGER) so they sort and diff without
--     any date parsing at the edge.
--   * The full analysis JSON lives in R2 (`results/<id>.json`), not here. D1
--     keeps the summary columns the list and dashboard views need, which keeps
--     rows small and every list query index-only.
--   * `workspaces` holds anonymous, self-issued identities. No personal data is
--     stored anywhere in this schema.

CREATE TABLE IF NOT EXISTS workspaces (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS analyses (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'error')),
  mode            TEXT NOT NULL CHECK (mode IN ('quick', 'forensic')),
  source          TEXT NOT NULL CHECK (source IN ('text', 'file')),
  filename        TEXT,
  r2_text_key     TEXT NOT NULL,
  r2_result_key   TEXT,
  text_sha256     TEXT NOT NULL,
  char_count      INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  engine_version  TEXT,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  completed_at    INTEGER,
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_analyses_workspace_created
  ON analyses (workspace_id, created_at DESC);

-- Supports the scheduled retry sweep, which looks for stalled work.
CREATE INDEX IF NOT EXISTS idx_analyses_status_created
  ON analyses (status, created_at);

-- Lets a repeated submission of identical text reuse an existing result.
CREATE INDEX IF NOT EXISTS idx_analyses_workspace_hash
  ON analyses (workspace_id, text_sha256, mode);

CREATE TABLE IF NOT EXISTS analysis_metrics (
  analysis_id      TEXT PRIMARY KEY,
  risk_score       REAL NOT NULL,
  risk_label       TEXT NOT NULL,
  watermark_score  REAL NOT NULL,
  watermark_label  TEXT NOT NULL,
  llm_score        REAL NOT NULL,
  llm_low          REAL NOT NULL,
  llm_high         REAL NOT NULL,
  llm_label        TEXT NOT NULL,
  llm_model_id     TEXT NOT NULL,
  llm_trained      INTEGER NOT NULL DEFAULT 0,
  language         TEXT,
  word_count       INTEGER NOT NULL,
  payload_count    INTEGER NOT NULL DEFAULT 0,
  signal_count     INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  FOREIGN KEY (analysis_id) REFERENCES analyses (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_metrics_risk ON analysis_metrics (risk_score DESC);

-- Per-segment scores, stored relationally so the heatmap and any future
-- "show me the riskiest passages" query do not need to parse the result blob.
CREATE TABLE IF NOT EXISTS analysis_segments (
  analysis_id     TEXT NOT NULL,
  idx             INTEGER NOT NULL,
  start_offset    INTEGER NOT NULL,
  end_offset      INTEGER NOT NULL,
  word_count      INTEGER NOT NULL,
  llm_likelihood  REAL NOT NULL,
  label           TEXT NOT NULL,
  watermark_hits  INTEGER NOT NULL DEFAULT 0,
  preview         TEXT NOT NULL,
  PRIMARY KEY (analysis_id, idx),
  FOREIGN KEY (analysis_id) REFERENCES analyses (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reports (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  analysis_id   TEXT NOT NULL,
  title         TEXT NOT NULL,
  notes         TEXT,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  FOREIGN KEY (analysis_id) REFERENCES analyses (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reports_workspace_created
  ON reports (workspace_id, created_at DESC);

-- Append-only operational log. Read by /api/stats and useful when a job fails.
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  TEXT,
  analysis_id   TEXT,
  type          TEXT NOT NULL,
  detail        TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_created ON events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_analysis ON events (analysis_id, created_at DESC);
