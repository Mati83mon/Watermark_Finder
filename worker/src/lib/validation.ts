/**
 * Request validation.
 *
 * Hand-written rather than schema-library driven: the surface is small, the
 * rules are specific (character budgets, mode enums, pagination bounds), and
 * keeping it dependency-free keeps the Worker bundle and its cold start small.
 */

import type { AnalysisMode } from '@wf/shared';
import { badRequest, payloadTooLarge } from './errors';

export const ANALYSIS_MODES: AnalysisMode[] = ['quick', 'forensic'];

export interface CreateAnalysisInput {
  text?: string;
  uploadId?: string;
  mode: AnalysisMode;
  filename?: string;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

export function parseMode(value: unknown, fallback: AnalysisMode = 'forensic'): AnalysisMode {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !ANALYSIS_MODES.includes(value as AnalysisMode)) {
    throw badRequest(`mode must be one of: ${ANALYSIS_MODES.join(', ')}`);
  }
  return value as AnalysisMode;
}

export function parseCreateAnalysis(body: unknown, maxChars: number): CreateAnalysisInput {
  const record = asRecord(body);
  const mode = parseMode(record.mode);

  const hasText = typeof record.text === 'string' && record.text.trim().length > 0;
  const hasUpload = typeof record.upload_id === 'string' && record.upload_id.length > 0;

  if (hasText === hasUpload) {
    throw badRequest('Provide exactly one of "text" or "upload_id"');
  }

  if (hasText) {
    const text = record.text as string;
    if (text.length > maxChars) {
      throw payloadTooLarge(
        `Text is ${text.length} characters; the limit is ${maxChars}`,
        { chars: text.length, limit: maxChars },
      );
    }
    return { text, mode };
  }

  const uploadId = record.upload_id as string;
  if (!/^[a-z0-9]{1,64}$/.test(uploadId)) {
    throw badRequest('upload_id is not a valid identifier');
  }
  return { uploadId, mode };
}

export interface CreateReportInput {
  analysisId: string;
  title: string;
  notes?: string;
}

export function parseCreateReport(body: unknown): CreateReportInput {
  const record = asRecord(body);

  const analysisId = record.analysis_id;
  if (typeof analysisId !== 'string' || !/^[a-z0-9]{1,64}$/.test(analysisId)) {
    throw badRequest('analysis_id is required');
  }

  const rawTitle = typeof record.title === 'string' ? record.title.trim() : '';
  if (rawTitle.length === 0) throw badRequest('title is required');
  if (rawTitle.length > 200) throw badRequest('title must be 200 characters or fewer');

  const rawNotes = typeof record.notes === 'string' ? record.notes.trim() : '';
  if (rawNotes.length > 5000) throw badRequest('notes must be 5000 characters or fewer');

  return {
    analysisId,
    title: rawTitle,
    ...(rawNotes ? { notes: rawNotes } : {}),
  };
}

export interface Pagination {
  limit: number;
  offset: number;
}

export function parsePagination(url: URL, defaultLimit = 20, maxLimit = 100): Pagination {
  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');

  const limit = limitParam === null ? defaultLimit : Number.parseInt(limitParam, 10);
  const offset = offsetParam === null ? 0 : Number.parseInt(offsetParam, 10);

  if (!Number.isFinite(limit) || limit < 1 || limit > maxLimit) {
    throw badRequest(`limit must be an integer between 1 and ${maxLimit}`);
  }
  if (!Number.isFinite(offset) || offset < 0) {
    throw badRequest('offset must be a non-negative integer');
  }
  return { limit, offset };
}

/** Filenames land in R2 keys and in reports; keep them boring. */
export function sanitizeFilename(name: string | undefined | null): string | null {
  if (!name) return null;
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '_')
    .trim()
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : null;
}
