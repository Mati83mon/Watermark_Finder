import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  ApiRequestError,
  clearSession,
  createSession,
  getBaseUrl,
  getToken,
  pollAnalysis,
  setBaseUrl,
} from '@/lib/api';

interface StubCall {
  url: string;
  method: string;
  headers: Headers;
}

function stubFetch(handler: (call: StubCall) => Response | Promise<Response>) {
  const calls: StubCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: StubCall = {
      url: typeof input === 'string' ? input : input.toString(),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

const SESSION = { workspace_id: 'w123', token: 'w123.signature', created_at: 1 };

beforeEach(() => {
  window.localStorage.clear();
  setBaseUrl('https://api.test');
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('base URL handling', () => {
  it('persists an override and strips trailing slashes', () => {
    setBaseUrl('https://other.test/api/');
    expect(getBaseUrl()).toBe('https://other.test/api');
  });

  it('falls back to the build-time default when cleared', () => {
    setBaseUrl(null);
    expect(getBaseUrl()).toBe('http://127.0.0.1:8787');
  });
});

describe('session bootstrap', () => {
  it('creates a session on the first authenticated request', async () => {
    const calls = stubFetch((call) => {
      if (call.url.endsWith('/api/session')) return Response.json(SESSION, { status: 201 });
      return Response.json({ items: [], total: 0, limit: 20, offset: 0 });
    });

    await api.listAnalyses();

    expect(calls[0]?.url).toBe('https://api.test/api/session');
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer w123.signature');
    expect(getToken()).toBe('w123.signature');
  });

  it('reuses an existing token', async () => {
    await createSessionWithStub();
    const calls = stubFetch(() => Response.json({ items: [], total: 0, limit: 20, offset: 0 }));
    await api.listAnalyses();
    expect(calls.filter((call) => call.url.endsWith('/api/session'))).toHaveLength(0);
  });

  it('re-issues the session once when the token is rejected', async () => {
    await createSessionWithStub();
    let rejected = false;
    const calls = stubFetch((call) => {
      if (call.url.endsWith('/api/session')) return Response.json(SESSION, { status: 201 });
      if (!rejected) {
        rejected = true;
        return Response.json({ error: 'unauthorized', message: 'nope' }, { status: 401 });
      }
      return Response.json({ items: [], total: 0, limit: 20, offset: 0 });
    });

    await expect(api.listAnalyses()).resolves.toMatchObject({ total: 0 });
    expect(calls.filter((call) => call.url.endsWith('/api/session'))).toHaveLength(1);
  });

  it('does not send a token on anonymous endpoints', async () => {
    const calls = stubFetch(() => Response.json({ modes: ['quick', 'forensic'] }));
    await api.capabilities();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get('authorization')).toBeNull();
  });
});

describe('error mapping', () => {
  it('surfaces the API error code and message', async () => {
    await createSessionWithStub();
    stubFetch(() =>
      Response.json(
        { error: 'rate_limited', message: 'Slow down', details: { retry_after_seconds: 30 } },
        { status: 429 },
      ),
    );

    await expect(api.listAnalyses()).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      message: 'Slow down',
    });
  });

  it('marks 429 and 5xx as retryable, 4xx as not', () => {
    expect(new ApiRequestError(429, 'x', 'y').retryable).toBe(true);
    expect(new ApiRequestError(503, 'x', 'y').retryable).toBe(true);
    expect(new ApiRequestError(400, 'x', 'y').retryable).toBe(false);
  });

  it('handles a non-JSON error body', async () => {
    await createSessionWithStub();
    stubFetch(() => new Response('<html>gateway error</html>', { status: 502 }));
    await expect(api.listAnalyses()).rejects.toMatchObject({ status: 502, code: 'http_error' });
  });
});

describe('request shaping', () => {
  it('sends JSON for object bodies', async () => {
    await createSessionWithStub();
    const calls = stubFetch(() => Response.json({ id: 'a1', status: 'pending' }, { status: 202 }));
    await api.createAnalysis({ text: 'hello', mode: 'quick' });
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
  });

  it('lets the browser set the boundary for uploads', async () => {
    await createSessionWithStub();
    const calls = stubFetch(() => Response.json({ upload_id: 'u1', filename: 'f', size: 1 }));
    await api.upload(new File(['data'], 'note.txt', { type: 'text/plain' }));
    expect(calls[0]?.headers.get('content-type')).toBeNull();
  });

  it('encodes ids in the path', async () => {
    await createSessionWithStub();
    const calls = stubFetch(() => Response.json({ id: 'x' }));
    await api.getAnalysis('a/../b');
    expect(calls[0]?.url).toBe('https://api.test/api/analyses/a%2F..%2Fb');
  });

  it('builds list query strings', async () => {
    await createSessionWithStub();
    const calls = stubFetch(() => Response.json({ items: [], total: 0, limit: 5, offset: 10 }));
    await api.listAnalyses({ limit: 5, offset: 10, status: 'done' });
    expect(calls[0]?.url).toContain('limit=5');
    expect(calls[0]?.url).toContain('offset=10');
    expect(calls[0]?.url).toContain('status=done');
  });
});

describe('pollAnalysis', () => {
  it('polls until the analysis is done', async () => {
    await createSessionWithStub();
    const statuses = ['pending', 'running', 'done'];
    let index = 0;
    stubFetch(() => Response.json({ id: 'a1', status: statuses[index++] ?? 'done' }));

    const updates: string[] = [];
    const settled = await pollAnalysis('a1', {
      initialDelayMs: 1,
      onUpdate: (analysis) => updates.push(analysis.status),
    });

    expect(settled.status).toBe('done');
    expect(updates).toEqual(['pending', 'running', 'done']);
  });

  it('returns immediately on a failed analysis', async () => {
    await createSessionWithStub();
    stubFetch(() => Response.json({ id: 'a1', status: 'error', error: 'engine down' }));
    const settled = await pollAnalysis('a1', { initialDelayMs: 1 });
    expect(settled.status).toBe('error');
  });

  it('gives up with a readable error after the timeout', async () => {
    await createSessionWithStub();
    stubFetch(() => Response.json({ id: 'a1', status: 'running' }));
    await expect(
      pollAnalysis('a1', { initialDelayMs: 1, timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: 'analysis_timeout' });
  });
});

describe('session teardown', () => {
  it('clears the stored token and workspace', async () => {
    await createSessionWithStub();
    expect(getToken()).toBeTruthy();
    clearSession();
    expect(getToken()).toBeNull();
  });
});

async function createSessionWithStub() {
  stubFetch(() => Response.json(SESSION, { status: 201 }));
  await createSession();
}
