import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/types';
import { createTestEnv, TestExecutionContext } from './harness/bindings';
import { installEngineStub, type EngineStub } from './harness/engine';

const app = createApp();

interface Harness {
  env: Env;
  ctx: TestExecutionContext;
  engine: EngineStub;
  token: string;
  request: (path: string, init?: RequestInit & { auth?: boolean }) => Promise<Response>;
}

async function setup(options: Parameters<typeof installEngineStub>[0] = {}): Promise<Harness> {
  const env = createTestEnv();
  const ctx = new TestExecutionContext();
  const engine = installEngineStub(options);

  const call = async (path: string, init: RequestInit & { auth?: boolean } = {}) => {
    const { auth = true, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (auth && harness.token) headers.set('authorization', `Bearer ${harness.token}`);
    return app.fetch(
      new Request(`https://api.test${path}`, { ...rest, headers }),
      env,
      ctx as unknown as ExecutionContext,
    );
  };

  const harness: Harness = { env, ctx, engine, token: '', request: call };

  const session = await call('/api/session', { method: 'POST', auth: false });
  harness.token = ((await session.json()) as { token: string }).token;
  return harness;
}

async function createAnalysis(harness: Harness, body: Record<string, unknown>) {
  const response = await harness.request('/api/analyses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await harness.ctx.settle();
  return response;
}

let active: EngineStub | null = null;
afterEach(() => {
  active?.restore();
  active = null;
});

describe('meta routes', () => {
  it('serves an index of the API', async () => {
    const harness = await setup();
    active = harness.engine;
    const response = await harness.request('/', { auth: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: 'watermark-finder-api' });
  });

  it('reports healthy when the engine and database answer', async () => {
    const harness = await setup();
    active = harness.engine;
    const response = await harness.request('/api/health', { auth: false });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe('ok');
    expect(body.checks.database).toBe('ok');
    expect(body.checks.engine).toBe('ok');
  });

  it('reports degraded with 503 when the engine is down', async () => {
    const harness = await setup({ healthy: false });
    active = harness.engine;
    const response = await harness.request('/api/health', { auth: false });
    expect(response.status).toBe(503);
    expect((await response.json()) as { status: string }).toMatchObject({ status: 'degraded' });
  });

  it('warns when SESSION_SECRET is missing', async () => {
    const env = createTestEnv({ SESSION_SECRET: undefined });
    const engine = installEngineStub();
    active = engine;
    const response = await app.fetch(
      new Request('https://api.test/api/health'),
      env,
      new TestExecutionContext() as unknown as ExecutionContext,
    );
    const body = (await response.json()) as { warnings: string[] };
    expect(body.warnings.some((w) => w.includes('SESSION_SECRET'))).toBe(true);
  });

  it('falls back to local limits when capabilities cannot be fetched', async () => {
    const env = createTestEnv({ ANALYSIS_SPACE_URL: '' });
    const engine = installEngineStub();
    active = engine;
    const response = await app.fetch(
      new Request('https://api.test/api/capabilities'),
      env,
      new TestExecutionContext() as unknown as ExecutionContext,
    );
    const body = (await response.json()) as { engine_reachable: boolean; modes: string[] };
    expect(response.status).toBe(200);
    expect(body.engine_reachable).toBe(false);
    expect(body.modes).toEqual(['quick', 'forensic']);
  });

  it('clamps engine limits to the Worker limits', async () => {
    const harness = await setup();
    active = harness.engine;
    const body = (await (await harness.request('/api/capabilities', { auth: false })).json()) as {
      max_upload_bytes: number;
    };
    expect(body.max_upload_bytes).toBe(1_048_576); // the Worker's cap, not the engine's
  });

  it('returns 404 as JSON for unknown routes', async () => {
    const harness = await setup();
    active = harness.engine;
    const response = await harness.request('/api/nope', { auth: false });
    expect(response.status).toBe(404);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'not_found' });
  });
});

describe('sessions and authorisation', () => {
  it('issues a workspace token', async () => {
    const harness = await setup();
    active = harness.engine;
    expect(harness.token).toContain('.');
  });

  it('rejects requests without a token', async () => {
    const harness = await setup();
    active = harness.engine;
    const response = await harness.request('/api/analyses', { auth: false });
    expect(response.status).toBe(401);
  });

  it('rejects a tampered token', async () => {
    const harness = await setup();
    active = harness.engine;
    const [id] = harness.token.split('.');
    const response = await harness.request('/api/analyses', {
      auth: false,
      headers: { authorization: `Bearer ${id}.forgedsignature` },
    });
    expect(response.status).toBe(401);
  });

  it('keeps workspaces isolated from each other', async () => {
    const harness = await setup();
    active = harness.engine;
    const created = await createAnalysis(harness, { text: 'x'.repeat(200), mode: 'quick' });
    const { id } = (await created.json()) as { id: string };

    const other = await harness.request('/api/session', { method: 'POST', auth: false });
    const otherToken = ((await other.json()) as { token: string }).token;

    const response = await harness.request(`/api/analyses/${id}`, {
      auth: false,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(response.status).toBe(404);
  });
});

describe('analysis lifecycle', () => {
  it('creates an analysis and completes it in the background', async () => {
    const harness = await setup();
    active = harness.engine;

    const created = await createAnalysis(harness, {
      text: 'A document worth checking. '.repeat(20),
      mode: 'forensic',
    });
    expect(created.status).toBe(202);
    const summary = (await created.json()) as { id: string; status: string };
    expect(summary.status).toBe('pending');

    const detail = await harness.request(`/api/analyses/${summary.id}`);
    const body = (await detail.json()) as {
      status: string;
      risk_score: number;
      watermark_label: string;
      result: { payloads: { text: string }[] } | null;
    };
    expect(body.status).toBe('done');
    expect(body.risk_score).toBeCloseTo(0.93);
    expect(body.watermark_label).toBe('payload_recovered');
    expect(body.result?.payloads[0]?.text).toBe('wm:demo-1');
  });

  it('passes the requested mode through to the engine', async () => {
    const harness = await setup();
    active = harness.engine;
    await createAnalysis(harness, { text: 'word '.repeat(60), mode: 'quick' });
    const analyzeCall = harness.engine.calls.find((call) => call.path === '/analyze');
    expect((analyzeCall?.body as { mode: string }).mode).toBe('quick');
  });

  it('stores segments relationally', async () => {
    const harness = await setup();
    active = harness.engine;
    const created = await createAnalysis(harness, { text: 'word '.repeat(80), mode: 'forensic' });
    const { id } = (await created.json()) as { id: string };

    const response = await harness.request(`/api/analyses/${id}/segments`);
    const body = (await response.json()) as { items: { index: number; label: string }[] };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.index).toBe(0);
    expect(body.items[1]?.label).toBe('mixed');
  });

  it('returns the stored source text', async () => {
    const harness = await setup();
    active = harness.engine;
    const text = 'The exact text that was submitted. '.repeat(5);
    const created = await createAnalysis(harness, { text, mode: 'quick' });
    const { id } = (await created.json()) as { id: string };

    const response = await harness.request(`/api/analyses/${id}/text`);
    expect((await response.json()) as { text: string }).toMatchObject({ text });
  });

  it('reuses a completed analysis for identical text and mode', async () => {
    const harness = await setup();
    active = harness.engine;
    const text = 'Deduplicate me. '.repeat(30);

    const first = await createAnalysis(harness, { text, mode: 'quick' });
    const firstId = ((await first.json()) as { id: string }).id;

    const second = await createAnalysis(harness, { text, mode: 'quick' });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { id: string; deduplicated: boolean };
    expect(body.deduplicated).toBe(true);
    expect(body.id).toBe(firstId);

    const analyzeCalls = harness.engine.calls.filter((call) => call.path === '/analyze');
    expect(analyzeCalls).toHaveLength(1);
  });

  it('does not reuse across modes', async () => {
    const harness = await setup();
    active = harness.engine;
    const text = 'Same text, different mode. '.repeat(20);
    await createAnalysis(harness, { text, mode: 'quick' });
    const second = await createAnalysis(harness, { text, mode: 'forensic' });
    expect(second.status).toBe(202);
  });

  it('lists and filters analyses', async () => {
    const harness = await setup();
    active = harness.engine;
    await createAnalysis(harness, { text: 'first document '.repeat(20), mode: 'quick' });
    await createAnalysis(harness, { text: 'second document '.repeat(20), mode: 'quick' });

    const all = (await (await harness.request('/api/analyses')).json()) as {
      items: unknown[];
      total: number;
    };
    expect(all.total).toBe(2);
    expect(all.items).toHaveLength(2);

    const done = (await (await harness.request('/api/analyses?status=done')).json()) as {
      total: number;
    };
    expect(done.total).toBe(2);

    const errored = (await (await harness.request('/api/analyses?status=error')).json()) as {
      total: number;
    };
    expect(errored.total).toBe(0);
  });

  it('paginates', async () => {
    const harness = await setup();
    active = harness.engine;
    for (let i = 0; i < 3; i += 1) {
      await createAnalysis(harness, { text: `document number ${i} `.repeat(20), mode: 'quick' });
    }
    const page = (await (await harness.request('/api/analyses?limit=2&offset=2')).json()) as {
      items: unknown[];
      total: number;
      offset: number;
    };
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
    expect(page.offset).toBe(2);
  });

  it('rejects invalid pagination', async () => {
    const harness = await setup();
    active = harness.engine;
    expect((await harness.request('/api/analyses?limit=0')).status).toBe(400);
    expect((await harness.request('/api/analyses?limit=500')).status).toBe(400);
    expect((await harness.request('/api/analyses?offset=-1')).status).toBe(400);
    expect((await harness.request('/api/analyses?status=weird')).status).toBe(400);
  });

  it('deletes an analysis and its stored objects', async () => {
    const harness = await setup();
    active = harness.engine;
    const created = await createAnalysis(harness, { text: 'delete me '.repeat(20), mode: 'quick' });
    const { id } = (await created.json()) as { id: string };

    expect((await harness.request(`/api/analyses/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await harness.request(`/api/analyses/${id}`)).status).toBe(404);
    expect((await harness.request(`/api/analyses/${id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('input validation', () => {
  it('requires exactly one of text or upload_id', async () => {
    const harness = await setup();
    active = harness.engine;
    expect((await createAnalysis(harness, {})).status).toBe(400);
    expect(
      (await createAnalysis(harness, { text: 'hello', upload_id: 'abc123' })).status,
    ).toBe(400);
  });

  it('rejects an unknown mode', async () => {
    const harness = await setup();
    active = harness.engine;
    expect((await createAnalysis(harness, { text: 'hello there', mode: 'turbo' })).status).toBe(400);
  });

  it('rejects text over the configured limit', async () => {
    const env = createTestEnv({ MAX_TEXT_CHARS: '50' });
    const engine = installEngineStub();
    active = engine;
    const ctx = new TestExecutionContext();
    const session = await app.fetch(
      new Request('https://api.test/api/session', { method: 'POST' }),
      env,
      ctx as unknown as ExecutionContext,
    );
    const token = ((await session.json()) as { token: string }).token;

    const response = await app.fetch(
      new Request('https://api.test/api/analyses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: 'x'.repeat(200) }),
      }),
      env,
      ctx as unknown as ExecutionContext,
    );
    expect(response.status).toBe(413);
  });

  it('rejects a malformed body', async () => {
    const harness = await setup();
    active = harness.engine;
    const response = await harness.request('/api/analyses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });
});

describe('uploads', () => {
  it('accepts a file and analyses it through the engine extractor', async () => {
    const harness = await setup({ extractText: 'Text pulled out of the PDF.' });
    active = harness.engine;

    const form = new FormData();
    form.append('file', new File([new Uint8Array([1, 2, 3, 4])], 'report.pdf'), 'report.pdf');
    const upload = await harness.request('/api/uploads', { method: 'POST', body: form });
    expect(upload.status).toBe(201);
    const { upload_id: uploadId } = (await upload.json()) as { upload_id: string };

    const created = await createAnalysis(harness, { upload_id: uploadId, mode: 'forensic' });
    expect(created.status).toBe(202);
    const { id } = (await created.json()) as { id: string };

    const detail = (await (await harness.request(`/api/analyses/${id}`)).json()) as {
      source: string;
      filename: string;
      status: string;
    };
    expect(detail.source).toBe('file');
    expect(detail.filename).toBe('report.pdf');
    expect(detail.status).toBe('done');

    const text = (await (await harness.request(`/api/analyses/${id}/text`)).json()) as {
      text: string;
    };
    expect(text.text).toBe('Text pulled out of the PDF.');
  });

  it('rejects unsupported file types', async () => {
    const harness = await setup();
    active = harness.engine;
    const form = new FormData();
    form.append('file', new File([new Uint8Array([1])], 'payload.exe'), 'payload.exe');
    const response = await harness.request('/api/uploads', { method: 'POST', body: form });
    expect(response.status).toBe(400);
  });

  it('rejects an empty file', async () => {
    const harness = await setup();
    active = harness.engine;
    const form = new FormData();
    form.append('file', new File([], 'empty.txt'), 'empty.txt');
    const response = await harness.request('/api/uploads', { method: 'POST', body: form });
    expect(response.status).toBe(400);
  });

  it('rejects a file over the size limit', async () => {
    const harness = await setup();
    active = harness.engine;
    const form = new FormData();
    form.append('file', new File([new Uint8Array(2 * 1024 * 1024)], 'big.txt'), 'big.txt');
    const response = await harness.request('/api/uploads', { method: 'POST', body: form });
    expect(response.status).toBe(413);
  });

  it('requires multipart bodies', async () => {
    const harness = await setup();
    active = harness.engine;
    const response = await harness.request('/api/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(400);
  });

  it('404s for an unknown upload id', async () => {
    const harness = await setup();
    active = harness.engine;
    const response = await createAnalysis(harness, { upload_id: 'unknownupload', mode: 'quick' });
    expect(response.status).toBe(404);
  });
});

describe('reports', () => {
  async function completedAnalysis(harness: Harness): Promise<string> {
    const created = await createAnalysis(harness, { text: 'report me '.repeat(30), mode: 'quick' });
    return ((await created.json()) as { id: string }).id;
  }

  it('creates, lists, reads and deletes', async () => {
    const harness = await setup();
    active = harness.engine;
    const analysisId = await completedAnalysis(harness);

    const created = await harness.request('/api/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ analysis_id: analysisId, title: 'Q3 leak check', notes: 'internal' }),
    });
    expect(created.status).toBe(201);
    const report = (await created.json()) as { id: string; title: string };
    expect(report.title).toBe('Q3 leak check');

    const list = (await (await harness.request('/api/reports')).json()) as { total: number };
    expect(list.total).toBe(1);

    const detail = (await (await harness.request(`/api/reports/${report.id}`)).json()) as {
      analysis: { result: { schema_version: string } | null } | null;
    };
    expect(detail.analysis?.result?.schema_version).toBe('1.0');

    expect((await harness.request(`/api/reports/${report.id}`, { method: 'DELETE' })).status).toBe(
      200,
    );
    expect((await harness.request(`/api/reports/${report.id}`)).status).toBe(404);
  });

  it('validates the payload', async () => {
    const harness = await setup();
    active = harness.engine;
    const analysisId = await completedAnalysis(harness);

    const missingTitle = await harness.request('/api/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ analysis_id: analysisId, title: '   ' }),
    });
    expect(missingTitle.status).toBe(400);

    const unknownAnalysis = await harness.request('/api/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ analysis_id: 'doesnotexist', title: 'x' }),
    });
    expect(unknownAnalysis.status).toBe(404);
  });
});

describe('stats', () => {
  it('summarises the workspace', async () => {
    const harness = await setup();
    active = harness.engine;
    await createAnalysis(harness, { text: 'first '.repeat(40), mode: 'quick' });
    await createAnalysis(harness, { text: 'second '.repeat(40), mode: 'quick' });

    const stats = (await (await harness.request('/api/stats')).json()) as {
      total: number;
      by_status: Record<string, number>;
      watermarks_detected: number;
      payloads_recovered: number;
      average_risk: number;
      last_7_days: { date: string; count: number }[];
    };
    expect(stats.total).toBe(2);
    expect(stats.by_status.done).toBe(2);
    expect(stats.watermarks_detected).toBe(2);
    expect(stats.payloads_recovered).toBe(2);
    expect(stats.average_risk).toBeCloseTo(0.93);
    expect(stats.last_7_days.length).toBeGreaterThan(0);
  });
});

describe('cross-origin and rate limiting', () => {
  it('answers preflight requests', async () => {
    const harness = await setup();
    active = harness.engine;
    const response = await harness.request('/api/analyses', {
      method: 'OPTIONS',
      auth: false,
      headers: { origin: 'https://app.test' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.test');
  });

  it('only reflects allow-listed origins', async () => {
    const env = createTestEnv({ ALLOWED_ORIGINS: 'https://allowed.test' });
    const engine = installEngineStub();
    active = engine;
    const ctx = new TestExecutionContext() as unknown as ExecutionContext;

    const allowed = await app.fetch(
      new Request('https://api.test/api/health', { headers: { origin: 'https://allowed.test' } }),
      env,
      ctx,
    );
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://allowed.test');

    const blocked = await app.fetch(
      new Request('https://api.test/api/health', { headers: { origin: 'https://evil.test' } }),
      env,
      ctx,
    );
    expect(blocked.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rate limits by IP and reports the reset', async () => {
    const env = createTestEnv({ RATE_LIMIT_REQUESTS: '2', RATE_LIMIT_WINDOW: '60' });
    const engine = installEngineStub();
    active = engine;
    const ctx = new TestExecutionContext() as unknown as ExecutionContext;
    const headers = { 'cf-connecting-ip': '203.0.113.9' };

    const first = await app.fetch(new Request('https://api.test/api/capabilities', { headers }), env, ctx);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-ratelimit-remaining')).toBe('1');

    await app.fetch(new Request('https://api.test/api/capabilities', { headers }), env, ctx);
    const third = await app.fetch(
      new Request('https://api.test/api/capabilities', { headers }),
      env,
      ctx,
    );
    expect(third.status).toBe(429);
    const body = (await third.json()) as { error: string; details: { retry_after_seconds: number } };
    expect(body.error).toBe('rate_limited');
    expect(body.details.retry_after_seconds).toBeGreaterThan(0);
  });

  it('enforces the daily analysis limit per workspace', async () => {
    const env = createTestEnv({ DAILY_ANALYSIS_LIMIT: '1' });
    const engine = installEngineStub();
    active = engine;
    const ctx = new TestExecutionContext();
    const session = await app.fetch(
      new Request('https://api.test/api/session', { method: 'POST' }),
      env,
      ctx as unknown as ExecutionContext,
    );
    const token = ((await session.json()) as { token: string }).token;

    const post = (text: string) =>
      app.fetch(
        new Request('https://api.test/api/analyses', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ text, mode: 'quick' }),
        }),
        env,
        ctx as unknown as ExecutionContext,
      );

    expect((await post('first document '.repeat(20))).status).toBe(202);
    await ctx.settle();
    expect((await post('second document '.repeat(20))).status).toBe(429);
  });
});

describe('request tracing', () => {
  it('echoes an inbound request id', async () => {
    const harness = await setup();
    active = harness.engine;
    const response = await harness.request('/api/capabilities', {
      auth: false,
      headers: { 'x-request-id': 'trace-123' },
    });
    expect(response.headers.get('x-request-id')).toBe('trace-123');
  });

  it('generates one when absent', async () => {
    const harness = await setup();
    active = harness.engine;
    const response = await harness.request('/api/capabilities', { auth: false });
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });
});

beforeEach(() => {
  active?.restore();
});

describe('POST /api/sanitize', () => {
  const hidden = [...'id:42']
    .map((ch) => String.fromCodePoint(0xe0000 + ch.charCodeAt(0)))
    .join('');

  it('strips hidden characters and returns the cleaned text', async () => {
    const harness = await setup();
    const response = await harness.request('/api/sanitize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `Confidential draft.${hidden}` }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { text: string; changed: boolean; removed_total: number };
    expect(body.text).toBe('Confidential draft.');
    expect(body.changed).toBe(true);
    expect(body.removed_total).toBe(5);
  });

  it('requires a workspace token', async () => {
    const harness = await setup();
    const response = await harness.request('/api/sanitize', {
      method: 'POST',
      auth: false,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(response.status).toBe(401);
  });

  it('rejects an unknown level', async () => {
    const harness = await setup();
    const response = await harness.request('/api/sanitize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', level: 'thorough' }),
    });
    expect(response.status).toBe(400);
  });

  it('stores nothing: sanitising is not an analysis', async () => {
    const harness = await setup();
    await harness.request('/api/sanitize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `Confidential draft.${hidden}` }),
    });

    const list = await harness.request('/api/analyses');
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(0);
  });
});

describe('POST /api/mark', () => {
  const doc = 'Zdanie pierwsze. Zdanie drugie. Zdanie trzecie.';

  it('returns one distinct copy per recipient', async () => {
    const harness = await setup();
    const response = await harness.request('/api/mark', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: doc, recipients: ['Jan', 'Anna'], template: 'WF-{index}' }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      copies: { recipient: string; payload: string; text: string; verified: boolean }[];
      warnings: string[];
    };
    expect(body.copies).toHaveLength(2);
    expect(new Set(body.copies.map((c) => c.text)).size).toBe(2);
    expect(body.copies.every((c) => c.verified)).toBe(true);
    expect(body.warnings.join(' ')).toContain('PDF');
  });

  it('rejects duplicate recipients before reaching the engine', async () => {
    const harness = await setup();
    const response = await harness.request('/api/mark', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: doc, recipients: ['Jan', 'Jan'] }),
    });
    expect(response.status).toBe(400);
    expect(harness.engine.calls.some((call) => call.path === '/mark')).toBe(false);
  });

  it('rejects an empty recipient list', async () => {
    const harness = await setup();
    const response = await harness.request('/api/mark', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: doc, recipients: [] }),
    });
    expect(response.status).toBe(400);
  });

  it('requires a workspace token', async () => {
    const harness = await setup();
    const response = await harness.request('/api/mark', {
      method: 'POST',
      auth: false,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: doc, recipients: ['Jan'] }),
    });
    expect(response.status).toBe(401);
  });

  it('stores nothing: the documents people mark are confidential', async () => {
    const harness = await setup();
    await harness.request('/api/mark', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: doc, recipients: ['Jan'] }),
    });
    const list = await harness.request('/api/analyses');
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(0);
  });
});

describe('POST /api/c2pa', () => {
  function png(): File {
    return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'photo.png', {
      type: 'image/png',
    });
  }

  async function send(harness: Harness, file: File | null, auth = true) {
    const form = new FormData();
    if (file) form.append('file', file);
    return harness.request('/api/c2pa', { method: 'POST', auth, body: form });
  }

  it('returns integrity and trust as separate fields', async () => {
    const harness = await setup();
    const response = await send(harness, png());

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      present: boolean;
      integrity: string;
      trust: string;
      ai_declared: boolean;
    };
    expect(body.present).toBe(true);
    expect(body.integrity).toBe('intact');
    // Never collapsed into one "verified" flag.
    expect(body.trust).toBe('unrecognised');
    expect(body.ai_declared).toBe(true);
  });

  it('requires a file field', async () => {
    const harness = await setup();
    const response = await send(harness, null);
    expect(response.status).toBe(400);
  });

  it('rejects an empty file', async () => {
    const harness = await setup();
    const response = await send(harness, new File([], 'empty.png', { type: 'image/png' }));
    expect(response.status).toBe(400);
  });

  it('requires a workspace token', async () => {
    const harness = await setup();
    const response = await send(harness, png(), false);
    expect(response.status).toBe(401);
  });

  it('stores nothing', async () => {
    const harness = await setup();
    await send(harness, png());
    const list = await harness.request('/api/analyses');
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(0);
  });
});
