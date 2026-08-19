/**
 * Typed client for the Worker API.
 *
 * The site is a static export, so there is no server to proxy through: the
 * browser talks to the Worker directly. The base URL comes from
 * `NEXT_PUBLIC_API_BASE_URL` at build time and can be overridden at runtime
 * from the Settings page, which is what makes a single build usable against a
 * local Worker, a preview deployment and production.
 */

import type {
  AnalysisDetail,
  AnalysisMode,
  AnalysisStatus,
  AnalysisSummary,
  MarkChannel,
  MarkResult,
  SanitizeLevel,
  SanitizeResult,
  ApiError,
  Capabilities,
  Paginated,
  Report,
  Segment,
  Session,
  Stats,
} from '@wf/shared';

const TOKEN_KEY = 'wf.workspace.token';
const WORKSPACE_KEY = 'wf.workspace.id';
const BASE_URL_KEY = 'wf.api.baseUrl';

export const DEFAULT_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, '') ?? 'http://127.0.0.1:8787';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** True when retrying the same request could plausibly succeed. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // Storage can throw in private modes and with third-party cookies blocked.
    return null;
  }
}

export function getBaseUrl(): string {
  return browserStorage()?.getItem(BASE_URL_KEY)?.replace(/\/+$/, '') || DEFAULT_BASE_URL;
}

export function setBaseUrl(url: string | null): void {
  const storage = browserStorage();
  if (!storage) return;
  if (url && url.trim()) {
    storage.setItem(BASE_URL_KEY, url.trim().replace(/\/+$/, ''));
  } else {
    storage.removeItem(BASE_URL_KEY);
  }
}

export function getToken(): string | null {
  return browserStorage()?.getItem(TOKEN_KEY) ?? null;
}

export function getWorkspaceId(): string | null {
  return browserStorage()?.getItem(WORKSPACE_KEY) ?? null;
}

export function clearSession(): void {
  const storage = browserStorage();
  storage?.removeItem(TOKEN_KEY);
  storage?.removeItem(WORKSPACE_KEY);
}

function storeSession(session: Session): void {
  const storage = browserStorage();
  storage?.setItem(TOKEN_KEY, session.token);
  storage?.setItem(WORKSPACE_KEY, session.workspace_id);
}

async function toError(response: Response): Promise<ApiRequestError> {
  let body: Partial<ApiError> = {};
  try {
    body = (await response.json()) as ApiError;
  } catch {
    // Non-JSON error bodies (a proxy error page, for instance).
  }
  return new ApiRequestError(
    response.status,
    body.error ?? 'http_error',
    body.message ?? `Request failed with status ${response.status}`,
    body.details,
  );
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skip the automatic session bootstrap (used by `createSession` itself). */
  anonymous?: boolean;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, anonymous, headers, ...rest } = options;

  if (!anonymous && !getToken()) {
    await createSession();
  }

  const requestHeaders = new Headers(headers);
  const token = getToken();
  if (!anonymous && token) requestHeaders.set('authorization', `Bearer ${token}`);

  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    requestHeaders.set('content-type', 'application/json');
    payload = JSON.stringify(body);
  }

  const response = await fetch(`${getBaseUrl()}${path}`, {
    ...rest,
    headers: requestHeaders,
    body: payload,
  });

  if (response.status === 401 && !anonymous) {
    // The workspace token was rejected - most likely the Worker's signing key
    // rotated. Start a fresh workspace and retry once.
    //
    // Only the request that used the *current* token is allowed to replace it:
    // when several requests are rejected together, the first refreshes and the
    // rest simply retry with whatever it produced, rather than each discarding
    // the previous one's fresh workspace.
    if (getToken() === token) {
      clearSession();
      await createSession();
    } else if (!getToken()) {
      await createSession();
    }
    const retryHeaders = new Headers(headers);
    const fresh = getToken();
    if (fresh) retryHeaders.set('authorization', `Bearer ${fresh}`);
    if (!(body instanceof FormData) && body !== undefined) {
      retryHeaders.set('content-type', 'application/json');
    }
    const retry = await fetch(`${getBaseUrl()}${path}`, {
      ...rest,
      headers: retryHeaders,
      body: payload,
    });
    if (!retry.ok) throw await toError(retry);
    return (await retry.json()) as T;
  }

  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

/**
 * In-flight bootstrap, shared by every concurrent caller.
 *
 * Without this, parallel requests each observe "no token" and each mint their
 * own workspace: the dashboard alone fires two requests at once, so a first
 * visit created two workspaces, the second token overwrote the first in storage,
 * and the request holding the losing token wrote into a workspace the browser no
 * longer had. Single-flighting the call makes the first visit deterministic.
 */
let pendingSession: Promise<Session> | null = null;

export async function createSession(): Promise<Session> {
  if (pendingSession) return pendingSession;

  pendingSession = (async () => {
    const response = await fetch(`${getBaseUrl()}/api/session`, { method: 'POST' });
    if (!response.ok) throw await toError(response);
    const session = (await response.json()) as Session;
    storeSession(session);
    return session;
  })();

  try {
    return await pendingSession;
  } finally {
    // Cleared on both paths: a failed bootstrap must not be cached, and a
    // successful one is now visible through getToken().
    pendingSession = null;
  }
}

export const api = {
  capabilities: (signal?: AbortSignal) =>
    request<Capabilities>('/api/capabilities', { anonymous: true, signal }),

  health: (signal?: AbortSignal) =>
    request<{ status: string; checks: Record<string, unknown>; warnings: string[] }>(
      '/api/health',
      { anonymous: true, signal },
    ),

  stats: (signal?: AbortSignal) => request<Stats>('/api/stats', { signal }),

  createAnalysis: (input: { text?: string; uploadId?: string; mode: AnalysisMode }) =>
    request<AnalysisSummary & { deduplicated?: boolean }>('/api/analyses', {
      method: 'POST',
      body: input.uploadId
        ? { upload_id: input.uploadId, mode: input.mode }
        : { text: input.text, mode: input.mode },
    }),

  mark: (input: {
    text: string;
    recipients: string[];
    template?: string;
    channel?: MarkChannel;
    repeat?: number;
  }) =>
    request<MarkResult>('/api/mark', {
      method: 'POST',
      body: {
        text: input.text,
        recipients: input.recipients,
        template: input.template ?? '{recipient}',
        channel: input.channel ?? 'tag_characters',
        repeat: input.repeat ?? 2,
      },
    }),

  sanitize: (input: { text: string; level?: SanitizeLevel; normalizeHomoglyphs?: boolean }) =>
    request<SanitizeResult>('/api/sanitize', {
      method: 'POST',
      body: {
        text: input.text,
        level: input.level ?? 'safe',
        normalize_homoglyphs: input.normalizeHomoglyphs ?? false,
      },
    }),

  listAnalyses: (
    params: { limit?: number; offset?: number; status?: AnalysisStatus } = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));
    if (params.status) query.set('status', params.status);
    const suffix = query.toString() ? `?${query}` : '';
    return request<Paginated<AnalysisSummary>>(`/api/analyses${suffix}`, { signal });
  },

  getAnalysis: (id: string, signal?: AbortSignal) =>
    request<AnalysisDetail>(`/api/analyses/${encodeURIComponent(id)}`, { signal }),

  getSegments: (id: string, signal?: AbortSignal) =>
    request<{ items: Segment[] }>(`/api/analyses/${encodeURIComponent(id)}/segments`, { signal }),

  getText: (id: string, signal?: AbortSignal) =>
    request<{ id: string; text: string; sha256: string }>(
      `/api/analyses/${encodeURIComponent(id)}/text`,
      { signal },
    ),

  deleteAnalysis: (id: string) =>
    request<{ deleted: boolean }>(`/api/analyses/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  upload: (file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request<{ upload_id: string; filename: string; size: number }>('/api/uploads', {
      method: 'POST',
      body: form,
    });
  },

  createReport: (input: { analysisId: string; title: string; notes?: string }) =>
    request<Report>('/api/reports', {
      method: 'POST',
      body: { analysis_id: input.analysisId, title: input.title, notes: input.notes },
    }),

  listReports: (params: { limit?: number; offset?: number } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));
    const suffix = query.toString() ? `?${query}` : '';
    return request<Paginated<Report>>(`/api/reports${suffix}`, { signal });
  },

  getReport: (id: string, signal?: AbortSignal) =>
    request<Report & { analysis: AnalysisDetail | null }>(
      `/api/reports/${encodeURIComponent(id)}`,
      { signal },
    ),

  deleteReport: (id: string) =>
    request<{ deleted: boolean }>(`/api/reports/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

/**
 * Poll an analysis until it leaves the pending/running states.
 *
 * The interval grows so a slow engine cold start does not turn into hundreds of
 * requests against the free-tier budget.
 */
export async function pollAnalysis(
  id: string,
  options: {
    signal?: AbortSignal;
    onUpdate?: (analysis: AnalysisDetail) => void;
    timeoutMs?: number;
    initialDelayMs?: number;
  } = {},
): Promise<AnalysisDetail> {
  const timeout = options.timeoutMs ?? 180_000;
  const started = Date.now();
  let delay = options.initialDelayMs ?? 1200;

  for (;;) {
    const analysis = await api.getAnalysis(id, options.signal);
    options.onUpdate?.(analysis);

    if (analysis.status === 'done' || analysis.status === 'error') return analysis;
    if (Date.now() - started > timeout) {
      throw new ApiRequestError(
        504,
        'analysis_timeout',
        'The analysis is taking longer than expected. It keeps running in the background - reload this page in a moment.',
      );
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(Math.round(delay * 1.4), 8000);
  }
}
