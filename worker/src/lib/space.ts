/**
 * Client for the Hugging Face Space that performs the analysis.
 *
 * Free Spaces sleep when idle and take tens of seconds to wake, so the client
 * retries on connection failures, timeouts and 5xx with exponential backoff and
 * jitter. Client errors (4xx) are never retried - they will fail identically.
 */

import type { AnalysisResult, Capabilities, SanitizeResult } from '@wf/shared';
import { badGateway } from './errors';

export interface SpaceClientOptions {
  baseUrl: string;
  token?: string;
  timeoutMs: number;
  maxRetries?: number;
  /** Injected in tests so backoff does not slow the suite down. */
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class SpaceClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: SpaceClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries ?? 2;
    this.sleep = options.sleep ?? defaultSleep;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: 'application/json',
      ...(this.token ? { 'x-api-key': this.token } : {}),
      ...extra,
    };
  }

  private async request(path: string, init: RequestInit, requestId?: string): Promise<Response> {
    if (!this.baseUrl) {
      throw badGateway('ANALYSIS_SPACE_URL is not configured');
    }

    let lastError = '';
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            ...(init.headers as Record<string, string> | undefined),
            ...(requestId ? { 'x-request-id': requestId } : {}),
          },
        });

        if (response.ok) return response;

        const body = await response.text();
        lastError = `HTTP ${response.status}: ${body.slice(0, 500)}`;

        if (!RETRYABLE_STATUS.has(response.status)) {
          throw badGateway(`Analysis engine rejected the request (${response.status})`, {
            status: response.status,
            body: body.slice(0, 500),
          });
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'HttpError') throw error;
        lastError =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : 'unknown transport failure';
      } finally {
        clearTimeout(timer);
      }

      if (attempt < this.maxRetries) {
        // 500ms, 1s, 2s ... plus jitter, so a cold Space gets time to wake up.
        const backoff = 500 * 2 ** attempt;
        await this.sleep(backoff + Math.floor(Math.random() * 250));
      }
    }

    throw badGateway(`Analysis engine unreachable after ${this.maxRetries + 1} attempts`, {
      last_error: lastError,
    });
  }

  async analyze(
    text: string,
    mode: string,
    clientReference?: string,
    requestId?: string,
    sourceFormat?: string,
  ): Promise<AnalysisResult> {
    const response = await this.request(
      '/analyze',
      {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          text,
          mode,
          client_reference: clientReference ?? null,
          source_format: sourceFormat ?? null,
        }),
      },
      requestId,
    );

    const payload = (await response.json()) as { result?: AnalysisResult };
    if (!payload?.result?.scores) {
      throw badGateway('Analysis engine returned a malformed response');
    }
    return payload.result;
  }

  async sanitize(
    text: string,
    level: string,
    normalizeHomoglyphs: boolean,
    requestId?: string,
  ): Promise<SanitizeResult> {
    const response = await this.request(
      '/sanitize',
      {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          text,
          level,
          normalize_homoglyphs: normalizeHomoglyphs,
        }),
      },
      requestId,
    );

    const payload = (await response.json()) as Partial<SanitizeResult>;
    if (typeof payload?.text !== 'string') {
      throw badGateway('Analysis engine returned a malformed response');
    }
    return payload as SanitizeResult;
  }

  async extract(
    file: Blob,
    filename: string,
    requestId?: string,
  ): Promise<{ text: string; format: string; truncated: boolean; notes: string[] }> {
    const form = new FormData();
    form.append('file', file, filename);
    const response = await this.request(
      '/extract',
      { method: 'POST', headers: this.headers(), body: form },
      requestId,
    );
    const payload = (await response.json()) as {
      text?: string;
      format?: string;
      truncated?: boolean;
      notes?: string[];
    };
    if (typeof payload.text !== 'string' || payload.text.length === 0) {
      throw badGateway('Analysis engine returned no text for this file');
    }
    return {
      text: payload.text,
      format: payload.format ?? 'unknown',
      truncated: payload.truncated ?? false,
      notes: payload.notes ?? [],
    };
  }

  async capabilities(): Promise<Omit<Capabilities, 'engine_reachable' | 'engine_version'>> {
    const response = await this.request('/capabilities', { method: 'GET', headers: this.headers() });
    return (await response.json()) as Omit<Capabilities, 'engine_reachable' | 'engine_version'>;
  }

  /** Liveness probe. Never throws: the health endpoint reports the outcome. */
  async health(): Promise<{ ok: boolean; version: string | null; detail?: string }> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 10_000));
      try {
        const response = await fetch(`${this.baseUrl}/health`, {
          headers: this.headers(),
          signal: controller.signal,
        });
        if (!response.ok) {
          return { ok: false, version: null, detail: `HTTP ${response.status}` };
        }
        const body = (await response.json()) as { version?: string };
        return { ok: true, version: body.version ?? null };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      return {
        ok: false,
        version: null,
        detail: error instanceof Error ? error.message : 'unreachable',
      };
    }
  }
}

export function createSpaceClient(
  baseUrl: string,
  token: string | undefined,
  timeoutMs: number,
): SpaceClient {
  return new SpaceClient({ baseUrl, token, timeoutMs });
}
