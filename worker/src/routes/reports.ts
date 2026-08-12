/** `/api/reports` - saved analyses with a title and notes. */

import type { Paginated, Report } from '@wf/shared';
import { Hono } from 'hono';
import { newId } from '../lib/crypto';
import { Database } from '../lib/db';
import { badRequest, notFound } from '../lib/errors';
import { Storage } from '../lib/storage';
import type { AppContext } from '../types';
import { parseCreateReport, parsePagination } from '../lib/validation';

export const reportsRoutes = new Hono<AppContext>();

reportsRoutes.post('/', async (c) => {
  const db = new Database(c.env.DB);
  const workspace = c.get('workspace');
  const input = parseCreateReport(await c.req.json().catch(() => null));

  const analysis = await db.getAnalysis(input.analysisId, workspace.id);
  if (!analysis) throw notFound('Analysis not found');
  if (analysis.status !== 'done') {
    throw badRequest('Only a completed analysis can be saved as a report');
  }

  const report = await db.createReport({
    id: newId('r'),
    workspaceId: workspace.id,
    analysisId: input.analysisId,
    title: input.title,
    notes: input.notes ?? null,
  });
  await db.recordEvent('report.created', report.title, workspace.id, input.analysisId);

  return c.json(report, 201);
});

reportsRoutes.get('/', async (c) => {
  const db = new Database(c.env.DB);
  const workspace = c.get('workspace');
  const { limit, offset } = parsePagination(new URL(c.req.url));

  const { items, total } = await db.listReports(workspace.id, limit, offset);
  const body: Paginated<Report> = { items, total, limit, offset };
  return c.json(body);
});

reportsRoutes.get('/:id', async (c) => {
  const db = new Database(c.env.DB);
  const storage = new Storage(c.env.BUCKET, c.env.CACHE);
  const workspace = c.get('workspace');

  const report = await db.getReport(c.req.param('id'), workspace.id);
  if (!report) throw notFound('Report not found');

  const analysis = await db.getAnalysis(report.analysis_id, workspace.id);
  const result =
    analysis?.r2_result_key ? await storage.getResult(analysis.r2_result_key) : null;

  return c.json({ ...report, analysis: analysis ? { ...analysis, result } : null });
});

reportsRoutes.delete('/:id', async (c) => {
  const db = new Database(c.env.DB);
  const workspace = c.get('workspace');
  const id = c.req.param('id');

  const deleted = await db.deleteReport(id, workspace.id);
  if (!deleted) throw notFound('Report not found');

  await db.recordEvent('report.deleted', null, workspace.id, null);
  return c.json({ deleted: true, id });
});
