/**
 * Worker entry point: HTTP handler plus the scheduled retry sweep.
 */

import { createApp } from './app';
import { getConfig } from './lib/config';
import { Database } from './lib/db';
import { sweepStalledAnalyses } from './lib/jobs';
import { createSpaceClient } from './lib/space';
import { Storage } from './lib/storage';
import type { Env } from './types';

const app = createApp();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  /**
   * Cron trigger (see `wrangler.toml`).
   *
   * The stall threshold is twice the Space timeout so a slow-but-alive request
   * is never retried while its first attempt is still running.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const config = getConfig(env);
    const deps = {
      db: new Database(env.DB),
      storage: new Storage(env.BUCKET, env.CACHE),
      space: createSpaceClient(
        env.ANALYSIS_SPACE_URL,
        env.ANALYSIS_SPACE_TOKEN,
        config.spaceTimeoutMs,
      ),
    };

    ctx.waitUntil(
      (async () => {
        const started = Date.now();
        const outcome = await sweepStalledAnalyses(deps, {
          maxAttempts: config.maxAttempts,
          stallAfterMs: config.spaceTimeoutMs * 2,
        });
        if (outcome.retried.length > 0 || outcome.failed.length > 0) {
          console.log('cron_sweep', {
            cron: event.cron,
            retried: outcome.retried.length,
            failed: outcome.failed.length,
            duration_ms: Date.now() - started,
          });
        }
      })(),
    );
  },
};
