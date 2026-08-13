/** `/api/analyses` - create, list, read, delete. */

import type { AnalysisDetail, AnalysisStatus, Paginated, AnalysisSummary } from '@wf/shared';
import { Hono } from 'hono';
import { getConfig } from '../lib/config';
import { newId, sha256Hex } from '../lib/crypto';
import { Database, toSummary } from '../lib/db';
import { badRequest, notFound } from '../lib/errors';
import { runAnalysis } from '../lib/jobs';
import { enforceDailyAnalysisLimit } from '../lib/ratelimit';
import { createSpaceClient } from '../lib/space';
import { Storage, textKey, uploadKey } from '../lib/storage';
import type { AppContext } from '../types';
import { parseCreateAnalysis, parsePagination, sanitizeFilename } from '../lib/validation';

const VALID_STATUSES: AnalysisStatus[] = ['pending', 'running', 'done', 'error'];

export const analysesRoutes = new Hono<AppContext>();

analysesRoutes.post('/', async (c) => {
  const config = getConfig(c.env);
  const db = new Database(c.env.DB);
  const storage = new Storage(c.env.BUCKET, c.env.CACHE);
  const workspace = c.get('workspace');
  const requestId = c.get('requestId');

  const input = parseCreateAnalysis(await c.req.json().catch(() => null), config.maxTextChars);
  await enforceDailyAnalysisLimit(c.env.CACHE, workspace.id, config.dailyAnalysisLimit);

  const space = createSpaceClient(
    c.env.ANALYSIS_SPACE_URL,
    c.env.ANALYSIS_SPACE_TOKEN,
    config.spaceTimeoutMs,
  );

  let text: string;
  let source: 'text' | 'file' = 'text';
  let filename: string | null = null;
  // Pasted text is exactly the bytes the user held; anything else has been
  // through an extractor that may have dropped invisible characters.
  let sourceFormat = 'text';

  if (input.text !== undefined) {
    text = input.text;
  } else {
    // Uploaded file: pull it from R2 and let the engine extract the text, which
    // keeps PDF/DOCX parsing off the edge entirely.
    const stored = await findUpload(c.env.BUCKET, workspace.id, input.uploadId!);
    if (!stored) throw notFound('Upload not found or expired');
    const upload = await storage.getUpload(stored.key);
    if (!upload) throw notFound('Upload not found or expired');

    const extracted = await space.extract(
      new Blob([upload.body], { type: upload.contentType }),
      stored.filename,
      requestId,
    );
    text = extracted.text;
    source = 'file';
    filename = stored.filename;
    sourceFormat = extracted.format;
  }

  if (text.trim().length === 0) {
    throw badRequest('The document contains no analysable text');
  }
  if (text.length > config.maxTextChars) {
    text = text.slice(0, config.maxTextChars);
  }

  const sha256 = await sha256Hex(text);

  // Identical text in the same mode: return the existing result instead of
  // spending another Space call on it.
  const reusable = await db.findReusableAnalysis(workspace.id, sha256, input.mode);
  if (reusable) {
    await db.recordEvent('analysis.deduplicated', reusable.id, workspace.id, reusable.id);
    return c.json({ ...toSummary(reusable), deduplicated: true }, 200);
  }

  const analysisId = newId('a');
  const key = textKey(workspace.id, analysisId);
  await storage.putText(key, text, { workspace: workspace.id, analysis: analysisId });
  await db.createAnalysis({
    id: analysisId,
    workspaceId: workspace.id,
    mode: input.mode,
    source,
    sourceFormat,
    filename,
    r2TextKey: key,
    textSha256: sha256,
    charCount: text.length,
  });
  await db.recordEvent('analysis.created', `mode=${input.mode} chars=${text.length}`, workspace.id, analysisId);

  // Hand the work to the runtime and answer immediately. Waiting on the Space
  // is I/O, so it does not consume the free plan's CPU budget.
  c.executionCtx.waitUntil(
    runAnalysis(
      { db, storage, space },
      {
        analysisId,
        workspaceId: workspace.id,
        mode: input.mode,
        textKey: key,
        requestId,
        maxAttempts: config.maxAttempts,
        sourceFormat,
      },
    ),
  );

  // Built from known state rather than re-read: the background job may already
  // have flipped the row to `running`, and the acknowledgement should describe
  // what was accepted, not who won that race.
  const accepted: AnalysisSummary = {
    id: analysisId,
    status: 'pending',
    mode: input.mode,
    source,
    filename,
    char_count: text.length,
    word_count: null,
    language: null,
    risk_score: null,
    risk_label: null,
    watermark_score: null,
    watermark_label: null,
    llm_score: null,
    llm_label: null,
    error: null,
    created_at: Date.now(),
    completed_at: null,
  };
  return c.json(accepted, 202);
});

analysesRoutes.get('/', async (c) => {
  const db = new Database(c.env.DB);
  const workspace = c.get('workspace');
  const url = new URL(c.req.url);
  const { limit, offset } = parsePagination(url);

  const statusParam = url.searchParams.get('status');
  if (statusParam && !VALID_STATUSES.includes(statusParam as AnalysisStatus)) {
    throw badRequest(`status must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  const { items, total } = await db.listAnalyses(
    workspace.id,
    limit,
    offset,
    (statusParam as AnalysisStatus) ?? undefined,
  );

  const body: Paginated<AnalysisSummary> = { items, total, limit, offset };
  return c.json(body);
});

analysesRoutes.get('/:id', async (c) => {
  const db = new Database(c.env.DB);
  const storage = new Storage(c.env.BUCKET, c.env.CACHE);
  const workspace = c.get('workspace');

  const row = await db.getAnalysis(c.req.param('id'), workspace.id);
  if (!row) throw notFound('Analysis not found');

  const includeResult = new URL(c.req.url).searchParams.get('include_result') !== 'false';
  const result =
    includeResult && row.r2_result_key ? await storage.getResult(row.r2_result_key) : null;

  const body: AnalysisDetail = {
    ...toSummary(row),
    text_sha256: row.text_sha256,
    attempts: row.attempts,
    engine_version: row.engine_version,
    result,
  };
  return c.json(body);
});

analysesRoutes.get('/:id/segments', async (c) => {
  const db = new Database(c.env.DB);
  const workspace = c.get('workspace');
  const id = c.req.param('id');

  const row = await db.getAnalysis(id, workspace.id);
  if (!row) throw notFound('Analysis not found');

  return c.json({ items: await db.listSegments(id) });
});

analysesRoutes.get('/:id/text', async (c) => {
  const db = new Database(c.env.DB);
  const storage = new Storage(c.env.BUCKET, c.env.CACHE);
  const workspace = c.get('workspace');

  const row = await db.getAnalysis(c.req.param('id'), workspace.id);
  if (!row) throw notFound('Analysis not found');

  const text = await storage.getText(row.r2_text_key);
  if (text === null) throw notFound('Source text is no longer stored');

  return c.json({ id: row.id, text, sha256: row.text_sha256 });
});

analysesRoutes.delete('/:id', async (c) => {
  const db = new Database(c.env.DB);
  const storage = new Storage(c.env.BUCKET, c.env.CACHE);
  const workspace = c.get('workspace');
  const id = c.req.param('id');

  const deleted = await db.deleteAnalysis(id, workspace.id);
  if (!deleted) throw notFound('Analysis not found');

  await storage.deleteAnalysisObjects(workspace.id, id);
  await db.recordEvent('analysis.deleted', null, workspace.id, id);
  return c.json({ deleted: true, id });
});

/**
 * Locate an upload by id. The filename is part of the key, so the prefix is
 * listed rather than guessed.
 */
async function findUpload(
  bucket: R2Bucket,
  workspaceId: string,
  uploadId: string,
): Promise<{ key: string; filename: string } | null> {
  const prefix = uploadKey(workspaceId, uploadId, '');
  const listing = await bucket.list({ prefix, limit: 1 });
  const object = listing.objects[0];
  if (!object) return null;
  return { key: object.key, filename: object.key.slice(prefix.length) || 'upload' };
}

export { sanitizeFilename };
