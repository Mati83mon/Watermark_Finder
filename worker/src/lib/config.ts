import type { Env } from '../types';

/**
 * Resolved runtime configuration.
 *
 * Every value is overridable through a `wrangler.toml` var so the same code
 * runs in dev, preview and production without conditional branches.
 */
export interface Config {
  allowedOrigins: string[];
  rateLimitRequests: number;
  rateLimitWindowSeconds: number;
  dailyAnalysisLimit: number;
  maxTextChars: number;
  maxUploadBytes: number;
  spaceTimeoutMs: number;
  maxAttempts: number;
  environment: string;
}

const DEFAULTS: Config = {
  allowedOrigins: ['*'],
  rateLimitRequests: 60,
  rateLimitWindowSeconds: 60,
  dailyAnalysisLimit: 200,
  maxTextChars: 200_000,
  maxUploadBytes: 10 * 1024 * 1024,
  spaceTimeoutMs: 45_000,
  maxAttempts: 3,
  environment: 'development',
};

function intOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getConfig(env: Env): Config {
  const origins = (env.ALLOWED_ORIGINS ?? '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    allowedOrigins: origins.length > 0 ? origins : DEFAULTS.allowedOrigins,
    rateLimitRequests: intOr(env.RATE_LIMIT_REQUESTS, DEFAULTS.rateLimitRequests),
    rateLimitWindowSeconds: intOr(env.RATE_LIMIT_WINDOW, DEFAULTS.rateLimitWindowSeconds),
    dailyAnalysisLimit: intOr(env.DAILY_ANALYSIS_LIMIT, DEFAULTS.dailyAnalysisLimit),
    maxTextChars: intOr(env.MAX_TEXT_CHARS, DEFAULTS.maxTextChars),
    maxUploadBytes: intOr(env.MAX_UPLOAD_BYTES, DEFAULTS.maxUploadBytes),
    spaceTimeoutMs: intOr(env.SPACE_TIMEOUT_MS, DEFAULTS.spaceTimeoutMs),
    maxAttempts: intOr(env.MAX_ATTEMPTS, DEFAULTS.maxAttempts),
    environment: env.ENVIRONMENT ?? DEFAULTS.environment,
  };
}

export { DEFAULTS as CONFIG_DEFAULTS };
