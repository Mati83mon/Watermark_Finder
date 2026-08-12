/**
 * R2 object layout and KV caching.
 *
 * R2 keys
 *   `uploads/<workspace>/<uploadId>/<filename>` - raw uploaded file
 *   `texts/<workspace>/<analysisId>.txt`        - text actually analysed
 *   `results/<workspace>/<analysisId>.json`     - full engine response
 *
 * Every key is prefixed with the workspace id, so a listing or a lifecycle rule
 * can operate per workspace and a mis-scoped read cannot cross workspaces.
 *
 * Result documents run to tens of kilobytes, which is why they live in R2
 * rather than D1; KV then caches the hot ones to keep repeat reads off R2.
 */

import type { AnalysisResult } from '@wf/shared';

export const RESULT_CACHE_TTL_SECONDS = 3600;
/** KV values are capped at 25 MB; stay well below and skip caching big results. */
const MAX_CACHEABLE_BYTES = 1_000_000;

export function uploadKey(workspaceId: string, uploadId: string, filename: string): string {
  return `uploads/${workspaceId}/${uploadId}/${filename}`;
}

export function textKey(workspaceId: string, analysisId: string): string {
  return `texts/${workspaceId}/${analysisId}.txt`;
}

export function resultKey(workspaceId: string, analysisId: string): string {
  return `results/${workspaceId}/${analysisId}.json`;
}

export class Storage {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly cache: KVNamespace,
  ) {}

  async putText(key: string, text: string, metadata: Record<string, string> = {}): Promise<void> {
    await this.bucket.put(key, text, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      customMetadata: metadata,
    });
  }

  async getText(key: string): Promise<string | null> {
    const object = await this.bucket.get(key);
    return object ? await object.text() : null;
  }

  async putUpload(
    key: string,
    body: ArrayBuffer,
    contentType: string,
    metadata: Record<string, string> = {},
  ): Promise<void> {
    await this.bucket.put(key, body, {
      httpMetadata: { contentType },
      customMetadata: metadata,
    });
  }

  async getUpload(key: string): Promise<{ body: ArrayBuffer; contentType: string } | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return {
      body: await object.arrayBuffer(),
      contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
    };
  }

  async putResult(key: string, result: AnalysisResult): Promise<void> {
    const serialized = JSON.stringify(result);
    await this.bucket.put(key, serialized, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
    if (serialized.length <= MAX_CACHEABLE_BYTES) {
      await this.cache.put(`result:${key}`, serialized, {
        expirationTtl: RESULT_CACHE_TTL_SECONDS,
      });
    }
  }

  async getResult(key: string): Promise<AnalysisResult | null> {
    const cached = await this.cache.get(`result:${key}`);
    if (cached) {
      try {
        return JSON.parse(cached) as AnalysisResult;
      } catch {
        // A corrupt cache entry must never mask the durable copy in R2.
        await this.cache.delete(`result:${key}`);
      }
    }

    const object = await this.bucket.get(key);
    if (!object) return null;
    const text = await object.text();
    if (text.length <= MAX_CACHEABLE_BYTES) {
      await this.cache.put(`result:${key}`, text, { expirationTtl: RESULT_CACHE_TTL_SECONDS });
    }
    return JSON.parse(text) as AnalysisResult;
  }

  /** Best-effort cleanup; a failed delete must not fail the request. */
  async deleteAnalysisObjects(workspaceId: string, analysisId: string): Promise<void> {
    const keys = [textKey(workspaceId, analysisId), resultKey(workspaceId, analysisId)];
    await Promise.all([
      ...keys.map((key) => this.bucket.delete(key).catch(() => undefined)),
      this.cache
        .delete(`result:${resultKey(workspaceId, analysisId)}`)
        .catch(() => undefined),
    ]);
  }
}
