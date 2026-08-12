/** Cross-cutting middleware: CORS, request ids, workspace auth, error mapping. */

import type { Context, MiddlewareHandler, Next } from 'hono';
import { getConfig } from './lib/config';
import { newId, signWorkspaceToken, verifyWorkspaceToken } from './lib/crypto';
import { Database } from './lib/db';
import { HttpError, serverError, unauthorized } from './lib/errors';
import { enforceRequestLimit, rateLimitHeaders } from './lib/ratelimit';
import type { AppContext } from './types';

/**
 * Fallback signing key for local development only.
 *
 * In production `SESSION_SECRET` is a Wrangler secret. If it were ever missing
 * there, tokens would be forgeable, so the health endpoint reports the
 * degraded state rather than letting it pass unnoticed.
 */
const DEV_SECRET = 'development-only-insecure-session-secret';

export function sessionSecret(env: { SESSION_SECRET?: string }): string {
  return env.SESSION_SECRET && env.SESSION_SECRET.length > 0 ? env.SESSION_SECRET : DEV_SECRET;
}

export function usingDevSecret(env: { SESSION_SECRET?: string }): boolean {
  return sessionSecret(env) === DEV_SECRET;
}

function resolveOrigin(requestOrigin: string | undefined, allowed: string[]): string | null {
  if (allowed.includes('*')) return requestOrigin ?? '*';
  if (!requestOrigin) return null;
  return allowed.includes(requestOrigin) ? requestOrigin : null;
}

export const cors: MiddlewareHandler<AppContext> = async (c, next) => {
  const { allowedOrigins } = getConfig(c.env);
  const origin = resolveOrigin(c.req.header('origin'), allowedOrigins);

  if (c.req.method === 'OPTIONS') {
    const headers: Record<string, string> = {
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization, x-workspace-token',
      'access-control-max-age': '86400',
      vary: 'origin',
    };
    if (origin) headers['access-control-allow-origin'] = origin;
    return new Response(null, { status: 204, headers });
  }

  await next();

  if (origin) {
    c.res.headers.set('access-control-allow-origin', origin);
    c.res.headers.set('vary', 'origin');
    c.res.headers.set(
      'access-control-expose-headers',
      'x-request-id, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset',
    );
  }
};

export const requestId: MiddlewareHandler<AppContext> = async (c, next) => {
  const id = c.req.header('x-request-id') ?? newId();
  c.set('requestId', id);
  await next();
  c.res.headers.set('x-request-id', id);
};

export const rateLimit: MiddlewareHandler<AppContext> = async (c, next) => {
  const config = getConfig(c.env);
  const result = await enforceRequestLimit(
    c.env.CACHE,
    c.req.raw,
    config.rateLimitRequests,
    config.rateLimitWindowSeconds,
  );
  await next();
  for (const [key, value] of Object.entries(rateLimitHeaders(result))) {
    c.res.headers.set(key, value);
  }
};

function extractToken(c: Context<AppContext>): string | null {
  const authorization = c.req.header('authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  return c.req.header('x-workspace-token') ?? null;
}

/**
 * Resolve the caller's workspace from its token.
 *
 * A workspace is an anonymous namespace, not an account: it carries no personal
 * data and exists only to keep one browser's analyses separate from another's.
 * Losing the token means losing access to that history, which is stated in the
 * UI.
 */
export const requireWorkspace: MiddlewareHandler<AppContext> = async (c, next) => {
  const token = extractToken(c);
  if (!token) {
    throw unauthorized('Create a session with POST /api/session first');
  }
  const workspaceId = await verifyWorkspaceToken(token, sessionSecret(c.env));
  if (!workspaceId) {
    throw unauthorized('Workspace token is invalid');
  }
  c.set('workspace', { id: workspaceId, createdAt: 0 });
  await new Database(c.env.DB).ensureWorkspace(workspaceId);
  await next();
};

export async function issueSession(env: { SESSION_SECRET?: string }, db: Database) {
  const workspaceId = newId('w');
  const now = Date.now();
  await db.ensureWorkspace(workspaceId, now);
  return {
    workspace_id: workspaceId,
    token: await signWorkspaceToken(workspaceId, sessionSecret(env)),
    created_at: now,
  };
}

/** Convert thrown errors into the documented JSON error shape. */
export async function errorHandler(error: Error, c: Context<AppContext>): Promise<Response> {
  const id = c.get('requestId');
  if (error instanceof HttpError) {
    return c.json(error.toJSON(id), error.status as 400);
  }
  console.error('unhandled_error', {
    request_id: id,
    path: new URL(c.req.url).pathname,
    message: error.message,
    stack: error.stack,
  });
  const fallback = serverError();
  return c.json(fallback.toJSON(id), 500);
}

export async function notFoundHandler(c: Context<AppContext>): Promise<Response> {
  return c.json(
    { error: 'not_found', message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}` },
    404,
  );
}

export type { Next };
