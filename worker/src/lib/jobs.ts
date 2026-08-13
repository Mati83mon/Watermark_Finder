/**
 * Analysis job execution.
 *
 * Cloudflare Queues are not on the free plan, so the pipeline is:
 *
 *   1. `POST /api/analyses` writes the text to R2 and a `pending` row to D1,
 *      then hands the job to `ctx.waitUntil()` and returns the id immediately.
 *   2. `runAnalysis` calls the Space, stores the result and flips the row to
 *      `done`. Waiting on the Space is I/O, which does not count against the
 *      10 ms CPU budget of the free plan.
 *   3. A cron trigger sweeps for jobs that never finished - an evicted isolate,
 *      a Space cold start that outran the timeout - and retries them until
 *      `MAX_ATTEMPTS`, after which they are failed with a readable message.
 *
 * The result is at-least-once execution. `runAnalysis` is written to be safe
 * under repetition: every write is an upsert or a full replace keyed by the
 * analysis id.
 */

import type { AnalysisResult } from '@wf/shared';
import { Database } from './db';
import { HttpError } from './errors';
import type { SpaceClient } from './space';
import { Storage, resultKey } from './storage';

export interface RunAnalysisDeps {
  db: Database;
  storage: Storage;
  space: SpaceClient;
}

export interface RunAnalysisJob {
  analysisId: string;
  workspaceId: string;
  mode: string;
  textKey: string;
  requestId?: string;
  /** Attempts allowed before the job is failed permanently. */
  maxAttempts?: number;
  /** Container the text was extracted from, so the engine can caveat the result. */
  sourceFormat?: string;
}

export interface RunOutcome {
  status: 'done' | 'error' | 'retry_scheduled';
  detail?: string;
}

export const DEFAULT_MAX_ATTEMPTS = 3;

export async function runAnalysis(
  deps: RunAnalysisDeps,
  job: RunAnalysisJob,
): Promise<RunOutcome> {
  const { db, storage, space } = deps;
  const startedAt = Date.now();

  try {
    await db.markRunning(job.analysisId, startedAt);

    const text = await storage.getText(job.textKey);
    if (text === null) {
      throw new HttpError(500, 'missing_source', 'Source text is no longer in storage');
    }

    const result = await space.analyze(
      text,
      job.mode,
      job.analysisId,
      job.requestId,
      job.sourceFormat,
    );
    await persistResult(deps, job, result);

    await db.recordEvent(
      'analysis.completed',
      `risk=${result.scores.risk.value} watermark=${result.scores.watermark.label} in ${
        Date.now() - startedAt
      }ms`,
      job.workspaceId,
      job.analysisId,
    );
    return { status: 'done' };
  } catch (error) {
    const message =
      error instanceof HttpError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Unknown failure';

    // A failure is only terminal once the attempt budget is spent. Below that,
    // the row goes back to `pending` so the cron sweep can pick it up - a Space
    // that is merely cold must not permanently fail a job.
    const maxAttempts = job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const row = await db.getAnalysis(job.analysisId);
    const attempts = row?.attempts ?? maxAttempts;

    if (attempts < maxAttempts) {
      await db.resetToPending(job.analysisId);
      await db.recordEvent(
        'analysis.retry_scheduled',
        `attempt ${attempts} failed: ${message}`,
        job.workspaceId,
        job.analysisId,
      );
      return { status: 'retry_scheduled', detail: message };
    }

    await db.markError(job.analysisId, message);
    await db.recordEvent('analysis.failed', message, job.workspaceId, job.analysisId);
    return { status: 'error', detail: message };
  }
}

async function persistResult(
  deps: RunAnalysisDeps,
  job: RunAnalysisJob,
  result: AnalysisResult,
): Promise<void> {
  const { db, storage } = deps;
  const key = resultKey(job.workspaceId, job.analysisId);

  await storage.putResult(key, result);

  await db.saveMetrics({
    analysis_id: job.analysisId,
    risk_score: result.scores.risk.value,
    risk_label: result.scores.risk.label,
    watermark_score: result.scores.watermark.value,
    watermark_label: result.scores.watermark.label,
    llm_score: result.scores.llm_likelihood.value,
    llm_low: result.scores.llm_likelihood.low,
    llm_high: result.scores.llm_likelihood.high,
    llm_label: result.scores.llm_likelihood.label,
    llm_model_id: result.scores.llm_likelihood.model_id,
    llm_trained: result.scores.llm_likelihood.trained ? 1 : 0,
    language: result.input.language,
    word_count: result.input.words,
    payload_count: result.payloads.length,
    signal_count: result.signals.length,
  });

  await db.replaceSegments(job.analysisId, result.segments);
  await db.markDone(job.analysisId, key, result.engine.version);
}

export interface SweepResult {
  retried: string[];
  failed: string[];
}

/**
 * Cron entry point: retry stalled jobs, permanently fail exhausted ones.
 *
 * `stallAfterMs` must exceed the Space timeout, otherwise a job that is merely
 * slow would be picked up while its first attempt is still in flight.
 */
export async function sweepStalledAnalyses(
  deps: RunAnalysisDeps,
  options: { maxAttempts: number; stallAfterMs: number; batchSize?: number },
): Promise<SweepResult> {
  const { db } = deps;
  const now = Date.now();
  const outcome: SweepResult = { retried: [], failed: [] };

  const exhausted = await db.findExhaustedAnalyses(options.maxAttempts);
  for (const row of exhausted) {
    await db.markError(
      row.id,
      `Giving up after ${row.attempts} attempt(s): the analysis engine did not return a result.`,
      now,
    );
    await db.recordEvent('analysis.abandoned', `attempts=${row.attempts}`, row.workspace_id, row.id);
    outcome.failed.push(row.id);
  }

  const stalled = await db.findStalledAnalyses(
    now - options.stallAfterMs,
    options.maxAttempts,
    options.batchSize ?? 5,
  );

  for (const row of stalled) {
    await db.recordEvent('analysis.retry', `attempt=${row.attempts + 1}`, row.workspace_id, row.id);
    const result = await runAnalysis(deps, {
      analysisId: row.id,
      workspaceId: row.workspace_id,
      mode: row.mode,
      textKey: row.r2_text_key,
      maxAttempts: options.maxAttempts,
      sourceFormat: row.source_format ?? undefined,
    });
    if (result.status === 'done') {
      outcome.retried.push(row.id);
    } else {
      outcome.failed.push(row.id);
    }
  }

  return outcome;
}
