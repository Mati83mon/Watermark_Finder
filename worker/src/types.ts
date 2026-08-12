/** Bindings and request-scoped context for the Worker. */

export interface Env {
  /** Relational store: analyses, metrics, segments, reports, events. */
  DB: D1Database;
  /** Cache and rate-limit counters. */
  CACHE: KVNamespace;
  /** Submitted text, uploaded files and full result documents. */
  BUCKET: R2Bucket;

  /** Base URL of the analysis Space, e.g. https://user-space.hf.space */
  ANALYSIS_SPACE_URL: string;
  /** Shared secret sent to the Space as X-API-Key. Set with `wrangler secret put`. */
  ANALYSIS_SPACE_TOKEN?: string;
  /** HMAC key for anonymous workspace tokens. Set with `wrangler secret put`. */
  SESSION_SECRET?: string;

  /** Comma-separated list of allowed browser origins, or `*`. */
  ALLOWED_ORIGINS?: string;
  /** Requests per window per IP. */
  RATE_LIMIT_REQUESTS?: string;
  /** Rate-limit window in seconds. */
  RATE_LIMIT_WINDOW?: string;
  /** Analyses per day per workspace. */
  DAILY_ANALYSIS_LIMIT?: string;
  /** Largest accepted document, in characters. */
  MAX_TEXT_CHARS?: string;
  /** Largest accepted upload, in bytes. */
  MAX_UPLOAD_BYTES?: string;
  /** Timeout for a single call to the Space, in milliseconds. */
  SPACE_TIMEOUT_MS?: string;
  /** How many times a failed analysis is retried by the cron sweep. */
  MAX_ATTEMPTS?: string;
  ENVIRONMENT?: string;
}

export interface Workspace {
  id: string;
  createdAt: number;
}

export interface Variables {
  requestId: string;
  workspace: Workspace;
}

export type AppContext = {
  Bindings: Env;
  Variables: Variables;
};
