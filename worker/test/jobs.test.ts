import { describe, expect, it, vi } from 'vitest';
import { Database } from '../src/lib/db';
import { DEFAULT_MAX_ATTEMPTS, runAnalysis, sweepStalledAnalyses } from '../src/lib/jobs';
import { SpaceClient } from '../src/lib/space';
import { Storage, textKey } from '../src/lib/storage';
import { createTestEnv } from './harness/bindings';
import { installEngineStub, makeResult } from './harness/engine';

const WORKSPACE = 'wtestworkspace';

async function scenario(options: Parameters<typeof installEngineStub>[0] = {}) {
  const env = createTestEnv();
  const engine = installEngineStub(options);
  const db = new Database(env.DB);
  const storage = new Storage(env.BUCKET, env.CACHE);
  const space = new SpaceClient({
    baseUrl: 'https://engine.test',
    token: 'engine-token',
    timeoutMs: 2000,
    maxRetries: 1,
    sleep: async () => {}, // no real backoff in tests
  });

  await db.ensureWorkspace(WORKSPACE);
  const analysisId = 'atestanalysis1';
  const key = textKey(WORKSPACE, analysisId);
  await storage.putText(key, 'Some text to analyse. '.repeat(20));
  await db.createAnalysis({
    id: analysisId,
    workspaceId: WORKSPACE,
    mode: 'forensic',
    source: 'text',
    sourceFormat: 'text',
    filename: null,
    r2TextKey: key,
    textSha256: 'b'.repeat(64),
    charCount: 440,
  });

  return { env, engine, db, storage, space, analysisId, key };
}

describe('runAnalysis', () => {
  it('completes a job and persists metrics, segments and the result', async () => {
    const { engine, db, storage, space, analysisId } = await scenario();
    try {
      const outcome = await runAnalysis({ db, storage, space }, {
        analysisId,
        workspaceId: WORKSPACE,
        mode: 'forensic',
        textKey: textKey(WORKSPACE, analysisId),
      });
      expect(outcome.status).toBe('done');

      const row = await db.getAnalysis(analysisId);
      expect(row?.status).toBe('done');
      expect(row?.attempts).toBe(1);
      expect(row?.engine_version).toBe('1.0.0');
      expect(row?.risk_score).toBeCloseTo(0.93);
      expect(row?.payload_count).toBe(1);

      expect(await db.listSegments(analysisId)).toHaveLength(2);
      expect(await storage.getResult(row!.r2_result_key!)).toMatchObject({
        schema_version: '1.0',
      });
    } finally {
      engine.restore();
    }
  });

  it('is safe to run twice - the second run replaces rather than duplicates', async () => {
    const { engine, db, storage, space, analysisId } = await scenario();
    try {
      const job = {
        analysisId,
        workspaceId: WORKSPACE,
        mode: 'forensic',
        textKey: textKey(WORKSPACE, analysisId),
      };
      await runAnalysis({ db, storage, space }, job);
      await runAnalysis({ db, storage, space }, job);

      expect(await db.listSegments(analysisId)).toHaveLength(2);
      const row = await db.getAnalysis(analysisId);
      expect(row?.status).toBe('done');
      expect(row?.attempts).toBe(2);
    } finally {
      engine.restore();
    }
  });

  it('schedules a retry instead of failing while attempts remain', async () => {
    const { engine, db, storage, space, analysisId } = await scenario({
      failTimes: 99,
      failStatus: 503,
    });
    try {
      const outcome = await runAnalysis({ db, storage, space }, {
        analysisId,
        workspaceId: WORKSPACE,
        mode: 'forensic',
        textKey: textKey(WORKSPACE, analysisId),
        maxAttempts: 3,
      });
      expect(outcome.status).toBe('retry_scheduled');

      const row = await db.getAnalysis(analysisId);
      expect(row?.status).toBe('pending');
      expect(row?.attempts).toBe(1);
      expect(row?.error).toBeNull();
    } finally {
      engine.restore();
    }
  });

  it('fails permanently once the attempt budget is spent', async () => {
    const { engine, db, storage, space, analysisId } = await scenario({
      failTimes: 99,
      failStatus: 503,
    });
    try {
      const job = {
        analysisId,
        workspaceId: WORKSPACE,
        mode: 'forensic',
        textKey: textKey(WORKSPACE, analysisId),
        maxAttempts: 2,
      };
      expect((await runAnalysis({ db, storage, space }, job)).status).toBe('retry_scheduled');
      expect((await runAnalysis({ db, storage, space }, job)).status).toBe('error');

      const row = await db.getAnalysis(analysisId);
      expect(row?.status).toBe('error');
      expect(row?.error).toContain('unreachable');
    } finally {
      engine.restore();
    }
  });

  it('fails the job when the source text has disappeared', async () => {
    const { engine, db, storage, space, analysisId } = await scenario();
    try {
      const outcome = await runAnalysis({ db, storage, space }, {
        analysisId,
        workspaceId: WORKSPACE,
        mode: 'forensic',
        textKey: 'texts/missing/key.txt',
        maxAttempts: 1,
      });
      expect(outcome.status).toBe('error');
      expect((await db.getAnalysis(analysisId))?.error).toContain('no longer in storage');
    } finally {
      engine.restore();
    }
  });

  it('tells the engine which container the text came from', async () => {
    const { engine, db, storage, space, analysisId } = await scenario();
    try {
      await runAnalysis({ db, storage, space }, {
        analysisId,
        workspaceId: WORKSPACE,
        mode: 'forensic',
        textKey: textKey(WORKSPACE, analysisId),
        sourceFormat: 'pdf',
      });
      // A clean covert-channel verdict on a PDF is uninformative, so the engine
      // has to be told the format in order to say so.
      const call = engine.calls.find((c) => c.path === '/analyze');
      expect((call?.body as { source_format: string }).source_format).toBe('pdf');
    } finally {
      engine.restore();
    }
  });

  it('uses the documented default attempt budget', () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(3);
  });
});

describe('sweepStalledAnalyses', () => {
  it('ignores a job that is still within its stall window', async () => {
    const { engine, db, storage, space } = await scenario();
    try {
      const outcome = await sweepStalledAnalyses(
        { db, storage, space },
        { maxAttempts: 3, stallAfterMs: 60_000 },
      );
      expect(outcome.retried).toEqual([]);
      expect(outcome.failed).toEqual([]);
    } finally {
      engine.restore();
    }
  });

  it('retries a job that has been pending past the threshold', async () => {
    const { engine, db, storage, space, analysisId } = await scenario();
    try {
      const outcome = await sweepStalledAnalyses(
        { db, storage, space },
        { maxAttempts: 3, stallAfterMs: -1 }, // everything counts as stalled
      );
      expect(outcome.retried).toEqual([analysisId]);
      expect((await db.getAnalysis(analysisId))?.status).toBe('done');
    } finally {
      engine.restore();
    }
  });

  it('abandons jobs that exhausted their attempts', async () => {
    const { engine, db, storage, space, analysisId } = await scenario();
    try {
      await db.markRunning(analysisId);
      await db.markRunning(analysisId);
      await db.markRunning(analysisId); // attempts = 3

      const outcome = await sweepStalledAnalyses(
        { db, storage, space },
        { maxAttempts: 3, stallAfterMs: -1 },
      );
      expect(outcome.failed).toEqual([analysisId]);

      const row = await db.getAnalysis(analysisId);
      expect(row?.status).toBe('error');
      expect(row?.error).toContain('Giving up after 3 attempt');
    } finally {
      engine.restore();
    }
  });
});

describe('SpaceClient', () => {
  it('retries a 503 and succeeds', async () => {
    const engine = installEngineStub({ failTimes: 1, failStatus: 503 });
    try {
      const client = new SpaceClient({
        baseUrl: 'https://engine.test',
        timeoutMs: 2000,
        maxRetries: 2,
        sleep: async () => {},
      });
      const result = await client.analyze('some text', 'quick');
      expect(result.scores.risk.value).toBeCloseTo(0.93);
      expect(engine.calls.filter((call) => call.path === '/analyze')).toHaveLength(2);
    } finally {
      engine.restore();
    }
  });

  it('retries transport failures', async () => {
    const engine = installEngineStub({ failTimes: 1, networkError: true });
    try {
      const client = new SpaceClient({
        baseUrl: 'https://engine.test',
        timeoutMs: 2000,
        maxRetries: 2,
        sleep: async () => {},
      });
      await expect(client.analyze('some text', 'quick')).resolves.toBeTruthy();
    } finally {
      engine.restore();
    }
  });

  it('does not retry a 4xx', async () => {
    const engine = installEngineStub({ failTimes: 99, failStatus: 422 });
    try {
      const client = new SpaceClient({
        baseUrl: 'https://engine.test',
        timeoutMs: 2000,
        maxRetries: 3,
        sleep: async () => {},
      });
      await expect(client.analyze('some text', 'quick')).rejects.toThrow(/rejected the request/);
      expect(engine.calls.filter((call) => call.path === '/analyze')).toHaveLength(1);
    } finally {
      engine.restore();
    }
  });

  it('gives up after the retry budget', async () => {
    const engine = installEngineStub({ failTimes: 99, failStatus: 500 });
    try {
      const client = new SpaceClient({
        baseUrl: 'https://engine.test',
        timeoutMs: 2000,
        maxRetries: 2,
        sleep: async () => {},
      });
      await expect(client.analyze('some text', 'quick')).rejects.toThrow(/unreachable after 3/);
    } finally {
      engine.restore();
    }
  });

  it('rejects a malformed engine response', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ nonsense: true })) as typeof fetch;
    try {
      const client = new SpaceClient({
        baseUrl: 'https://engine.test',
        timeoutMs: 2000,
        maxRetries: 0,
        sleep: async () => {},
      });
      await expect(client.analyze('text', 'quick')).rejects.toThrow(/malformed/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('fails fast when no base URL is configured', async () => {
    const client = new SpaceClient({ baseUrl: '', timeoutMs: 1000, sleep: async () => {} });
    await expect(client.analyze('text', 'quick')).rejects.toThrow(/not configured/);
  });

  it('aborts a request that exceeds the timeout', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as typeof fetch;
    try {
      const client = new SpaceClient({
        baseUrl: 'https://engine.test',
        timeoutMs: 10,
        maxRetries: 0,
        sleep: async () => {},
      });
      await expect(client.analyze('text', 'quick')).rejects.toThrow(/unreachable/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('reports engine health without throwing', async () => {
    const engine = installEngineStub({ healthy: false });
    try {
      const client = new SpaceClient({ baseUrl: 'https://engine.test', timeoutMs: 1000 });
      expect(await client.health()).toMatchObject({ ok: false });
    } finally {
      engine.restore();
    }
  });

  it('sends the API key to the engine', async () => {
    const seen: Record<string, string>[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return Response.json({ result: makeResult() });
    }) as typeof fetch;
    try {
      const client = new SpaceClient({
        baseUrl: 'https://engine.test',
        token: 'shhh',
        timeoutMs: 1000,
      });
      await client.analyze('text', 'quick');
      expect(seen[0]?.['x-api-key']).toBe('shhh');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('storage caching', () => {
  it('serves a cached result and survives a corrupt cache entry', async () => {
    const env = createTestEnv();
    const storage = new Storage(env.BUCKET, env.CACHE);
    const key = 'results/w1/a1.json';
    const result = makeResult();

    await storage.putResult(key, result);
    expect(await storage.getResult(key)).toMatchObject({ schema_version: '1.0' });

    await env.CACHE.put(`result:${key}`, 'not json');
    expect(await storage.getResult(key)).toMatchObject({ schema_version: '1.0' });
  });

  it('returns null for a missing result', async () => {
    const env = createTestEnv();
    const storage = new Storage(env.BUCKET, env.CACHE);
    expect(await storage.getResult('results/none.json')).toBeNull();
  });
});

describe('scheduled handler', () => {
  it('runs the sweep through the Worker entry point', async () => {
    const { engine, env, analysisId } = await scenario();
    try {
      const module = await import('../src/index');
      const pending: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
        passThroughOnException: () => {},
      } as unknown as ExecutionContext;

      // Age the job past the stall threshold (2x the 5s test timeout) by
      // moving the clock, faking Date only so the client's abort timer still
      // behaves normally.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 10 * 60_000);
      try {
        await module.default.scheduled(
          {
            cron: '*/5 * * * *',
            scheduledTime: Date.now(),
            noRetry: () => {},
          } as ScheduledController,
          env,
          ctx,
        );
        await Promise.all(pending);
      } finally {
        vi.useRealTimers();
      }

      expect((await new Database(env.DB).getAnalysis(analysisId))?.status).toBe('done');
    } finally {
      engine.restore();
    }
  });
});

describe('identifiers', () => {
  it('produces sortable, unique ids', async () => {
    const { newId } = await import('../src/lib/crypto');
    const ids = Array.from({ length: 200 }, () => newId('a'));
    expect(new Set(ids).size).toBe(200);
    expect(ids.every((id) => /^a[0-9a-z]{24}$/.test(id))).toBe(true);
  });

  it('orders ids by creation time', async () => {
    const { newId } = await import('../src/lib/crypto');
    const first = newId();
    vi.setSystemTime(Date.now() + 60_000);
    const second = newId();
    vi.useRealTimers();
    expect(second > first).toBe(true);
  });
});
