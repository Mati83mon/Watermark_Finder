/**
 * Fixed-window rate limiting on top of KV.
 *
 * KV is eventually consistent, so a determined client can squeeze a few extra
 * requests through during propagation. That is an accepted trade-off: the goal
 * is to keep one browser from exhausting the free-tier budget, not to enforce a
 * billing boundary. The daily analysis counter is the one that actually
 * protects the Space, and it is checked on the write path only.
 */

import { tooManyRequests } from './errors';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: number;
}

async function bump(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000;
  const windowKey = `${key}:${windowStart}`;
  const resetAt = windowStart + windowSeconds * 1000;

  const current = Number.parseInt((await kv.get(windowKey)) ?? '0', 10) || 0;
  const next = current + 1;

  // TTL outlives the window by a minute so a late read never resurrects a
  // stale counter into the following window.
  await kv.put(windowKey, String(next), { expirationTtl: windowSeconds + 60 });

  return {
    allowed: next <= limit,
    remaining: Math.max(0, limit - next),
    limit,
    resetAt,
  };
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

export async function enforceRequestLimit(
  kv: KVNamespace,
  request: Request,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const result = await bump(kv, `rl:ip:${clientIp(request)}`, limit, windowSeconds);
  if (!result.allowed) {
    const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
    throw tooManyRequests(
      `Rate limit exceeded: ${limit} requests per ${windowSeconds}s. Retry in ${retryAfter}s.`,
      retryAfter,
    );
  }
  return result;
}

export async function enforceDailyAnalysisLimit(
  kv: KVNamespace,
  workspaceId: string,
  limit: number,
): Promise<RateLimitResult> {
  const daySeconds = 86_400;
  const result = await bump(kv, `rl:day:${workspaceId}`, limit, daySeconds);
  if (!result.allowed) {
    const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
    throw tooManyRequests(
      `Daily analysis limit of ${limit} reached for this workspace.`,
      retryAfter,
    );
  }
  return result;
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'x-ratelimit-limit': String(result.limit),
    'x-ratelimit-remaining': String(result.remaining),
    'x-ratelimit-reset': String(Math.ceil(result.resetAt / 1000)),
  };
}
