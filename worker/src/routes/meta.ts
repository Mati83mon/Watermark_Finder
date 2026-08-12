/** Health, capabilities, session and stats. */

import type { Capabilities } from '@wf/shared';
import { Hono } from 'hono';
import { getConfig } from '../lib/config';
import { Database } from '../lib/db';
import { createSpaceClient } from '../lib/space';
import type { AppContext } from '../types';
import { issueSession, requireWorkspace, usingDevSecret } from '../middleware';

const CAPABILITIES_CACHE_KEY = 'capabilities:v1';
const CAPABILITIES_TTL_SECONDS = 300;

export const metaRoutes = new Hono<AppContext>();

/**
 * Liveness plus a real dependency check.
 *
 * Returns 200 when the Worker itself is serving and 503 when a dependency it
 * cannot work without is down, so an uptime check reflects user-visible state
 * rather than just "the isolate booted".
 */
metaRoutes.get('/health', async (c) => {
  const config = getConfig(c.env);
  const started = Date.now();

  const [engine, dbOk] = await Promise.all([
    createSpaceClient(
      c.env.ANALYSIS_SPACE_URL,
      c.env.ANALYSIS_SPACE_TOKEN,
      Math.min(config.spaceTimeoutMs, 8000),
    ).health(),
    new Database(c.env.DB)
      .stats('__health__')
      .then(() => true)
      .catch(() => false),
  ]);

  const warnings: string[] = [];
  if (usingDevSecret(c.env)) {
    warnings.push('SESSION_SECRET is not set; workspace tokens are signed with a known key.');
  }
  if (!c.env.ANALYSIS_SPACE_URL) {
    warnings.push('ANALYSIS_SPACE_URL is not configured.');
  }

  const healthy = dbOk && engine.ok;
  return c.json(
    {
      status: healthy ? 'ok' : 'degraded',
      environment: config.environment,
      checks: {
        database: dbOk ? 'ok' : 'error',
        engine: engine.ok ? 'ok' : 'unreachable',
        engine_version: engine.version,
        engine_detail: engine.detail ?? null,
      },
      warnings,
      latency_ms: Date.now() - started,
    },
    healthy ? 200 : 503,
  );
});

metaRoutes.get('/capabilities', async (c) => {
  const config = getConfig(c.env);

  const cached = await c.env.CACHE.get(CAPABILITIES_CACHE_KEY);
  if (cached) {
    return c.json(JSON.parse(cached) as Capabilities);
  }

  const space = createSpaceClient(
    c.env.ANALYSIS_SPACE_URL,
    c.env.ANALYSIS_SPACE_TOKEN,
    Math.min(config.spaceTimeoutMs, 10_000),
  );

  let body: Capabilities;
  try {
    const [engineCapabilities, health] = await Promise.all([space.capabilities(), space.health()]);
    body = {
      ...engineCapabilities,
      // The Worker's own limits are the binding ones for a browser client.
      max_chars: Math.min(engineCapabilities.max_chars, config.maxTextChars),
      max_upload_bytes: Math.min(engineCapabilities.max_upload_bytes, config.maxUploadBytes),
      engine_version: health.version,
      engine_reachable: health.ok,
    };
    await c.env.CACHE.put(CAPABILITIES_CACHE_KEY, JSON.stringify(body), {
      expirationTtl: CAPABILITIES_TTL_SECONDS,
    });
  } catch {
    // The engine being asleep must not stop the UI from rendering its form.
    body = {
      modes: ['quick', 'forensic'],
      max_chars: config.maxTextChars,
      max_upload_bytes: config.maxUploadBytes,
      supported_uploads: ['.txt', '.md', '.pdf', '.docx', '.html', '.json'],
      perplexity_enabled: false,
      engine_version: null,
      engine_reachable: false,
    };
  }

  return c.json(body);
});

metaRoutes.post('/session', async (c) => {
  const session = await issueSession(c.env, new Database(c.env.DB));
  return c.json(session, 201);
});

metaRoutes.get('/stats', requireWorkspace, async (c) => {
  const db = new Database(c.env.DB);
  return c.json(await db.stats(c.get('workspace').id));
});
