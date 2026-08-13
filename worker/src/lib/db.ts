/**
 * D1 access layer.
 *
 * All SQL lives here so the routes stay readable and so every query can be
 * checked against the schema in one place. Statements are always parameterised.
 */

import type {
  AnalysisMode,
  AnalysisStatus,
  AnalysisSummary,
  Report,
  Segment,
  Stats,
} from '@wf/shared';

export interface AnalysisRow {
  id: string;
  workspace_id: string;
  status: AnalysisStatus;
  mode: AnalysisMode;
  source: 'text' | 'file';
  source_format: string | null;
  filename: string | null;
  r2_text_key: string;
  r2_result_key: string | null;
  text_sha256: string;
  char_count: number;
  attempts: number;
  engine_version: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface MetricsRow {
  analysis_id: string;
  risk_score: number;
  risk_label: string;
  watermark_score: number;
  watermark_label: string;
  llm_score: number;
  llm_low: number;
  llm_high: number;
  llm_label: string;
  llm_model_id: string;
  llm_trained: number;
  language: string | null;
  word_count: number;
  payload_count: number;
  signal_count: number;
  created_at: number;
}

export interface AnalysisJoinedRow extends AnalysisRow, Partial<Omit<MetricsRow, 'created_at'>> {}

const SUMMARY_SELECT = `
  SELECT a.id, a.workspace_id, a.status, a.mode, a.source, a.source_format, a.filename,
         a.r2_text_key, a.r2_result_key, a.text_sha256, a.char_count, a.attempts,
         a.engine_version, a.error, a.created_at, a.started_at, a.completed_at,
         m.risk_score, m.risk_label, m.watermark_score, m.watermark_label,
         m.llm_score, m.llm_low, m.llm_high, m.llm_label, m.llm_model_id,
         m.llm_trained, m.language, m.word_count, m.payload_count, m.signal_count
  FROM analyses a
  LEFT JOIN analysis_metrics m ON m.analysis_id = a.id
`;

export function toSummary(row: AnalysisJoinedRow): AnalysisSummary {
  return {
    id: row.id,
    status: row.status,
    mode: row.mode,
    source: row.source,
    filename: row.filename,
    char_count: row.char_count,
    word_count: row.word_count ?? null,
    language: row.language ?? null,
    risk_score: row.risk_score ?? null,
    risk_label: (row.risk_label as AnalysisSummary['risk_label']) ?? null,
    watermark_score: row.watermark_score ?? null,
    watermark_label: (row.watermark_label as AnalysisSummary['watermark_label']) ?? null,
    llm_score: row.llm_score ?? null,
    llm_label: (row.llm_label as AnalysisSummary['llm_label']) ?? null,
    error: row.error,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

export class Database {
  constructor(private readonly db: D1Database) {}

  // ---------------------------------------------------------------- workspaces
  async ensureWorkspace(id: string, now = Date.now()): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO workspaces (id, created_at, last_seen_at) VALUES (?1, ?2, ?2)
         ON CONFLICT (id) DO UPDATE SET last_seen_at = ?2`,
      )
      .bind(id, now)
      .run();
  }

  // ------------------------------------------------------------------ analyses
  async createAnalysis(row: {
    id: string;
    workspaceId: string;
    mode: AnalysisMode;
    source: 'text' | 'file';
    sourceFormat: string | null;
    filename: string | null;
    r2TextKey: string;
    textSha256: string;
    charCount: number;
    now?: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO analyses
           (id, workspace_id, status, mode, source, source_format, filename,
            r2_text_key, text_sha256, char_count, attempts, created_at)
         VALUES (?1, ?2, 'pending', ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10)`,
      )
      .bind(
        row.id,
        row.workspaceId,
        row.mode,
        row.source,
        row.sourceFormat,
        row.filename,
        row.r2TextKey,
        row.textSha256,
        row.charCount,
        row.now ?? Date.now(),
      )
      .run();
  }

  async getAnalysis(id: string, workspaceId?: string): Promise<AnalysisJoinedRow | null> {
    const query = workspaceId
      ? `${SUMMARY_SELECT} WHERE a.id = ?1 AND a.workspace_id = ?2`
      : `${SUMMARY_SELECT} WHERE a.id = ?1`;
    const statement = workspaceId
      ? this.db.prepare(query).bind(id, workspaceId)
      : this.db.prepare(query).bind(id);
    return (await statement.first<AnalysisJoinedRow>()) ?? null;
  }

  async listAnalyses(
    workspaceId: string,
    limit: number,
    offset: number,
    status?: AnalysisStatus,
  ): Promise<{ items: AnalysisSummary[]; total: number }> {
    const where = status
      ? 'WHERE a.workspace_id = ?1 AND a.status = ?2'
      : 'WHERE a.workspace_id = ?1';

    const listQuery = `${SUMMARY_SELECT} ${where} ORDER BY a.created_at DESC LIMIT ?${
      status ? 3 : 2
    } OFFSET ?${status ? 4 : 3}`;
    const countQuery = `SELECT COUNT(*) AS total FROM analyses a ${where}`;

    const listStatement = status
      ? this.db.prepare(listQuery).bind(workspaceId, status, limit, offset)
      : this.db.prepare(listQuery).bind(workspaceId, limit, offset);
    const countStatement = status
      ? this.db.prepare(countQuery).bind(workspaceId, status)
      : this.db.prepare(countQuery).bind(workspaceId);

    const [list, count] = await Promise.all([
      listStatement.all<AnalysisJoinedRow>(),
      countStatement.first<{ total: number }>(),
    ]);

    return {
      items: (list.results ?? []).map(toSummary),
      total: count?.total ?? 0,
    };
  }

  async findReusableAnalysis(
    workspaceId: string,
    sha256: string,
    mode: AnalysisMode,
  ): Promise<AnalysisJoinedRow | null> {
    return (
      (await this.db
        .prepare(
          `${SUMMARY_SELECT}
           WHERE a.workspace_id = ?1 AND a.text_sha256 = ?2 AND a.mode = ?3 AND a.status = 'done'
           ORDER BY a.created_at DESC LIMIT 1`,
        )
        .bind(workspaceId, sha256, mode)
        .first<AnalysisJoinedRow>()) ?? null
    );
  }

  async markRunning(id: string, now = Date.now()): Promise<void> {
    await this.db
      .prepare(
        `UPDATE analyses
         SET status = 'running', started_at = ?2, attempts = attempts + 1, error = NULL
         WHERE id = ?1`,
      )
      .bind(id, now)
      .run();
  }

  async markDone(
    id: string,
    resultKey: string,
    engineVersion: string,
    now = Date.now(),
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE analyses
         SET status = 'done', r2_result_key = ?2, engine_version = ?3,
             completed_at = ?4, error = NULL
         WHERE id = ?1`,
      )
      .bind(id, resultKey, engineVersion, now)
      .run();
  }

  async markError(id: string, message: string, now = Date.now()): Promise<void> {
    await this.db
      .prepare(
        `UPDATE analyses SET status = 'error', error = ?2, completed_at = ?3 WHERE id = ?1`,
      )
      .bind(id, message.slice(0, 1000), now)
      .run();
  }

  async resetToPending(id: string): Promise<void> {
    await this.db
      .prepare(`UPDATE analyses SET status = 'pending', started_at = NULL WHERE id = ?1`)
      .bind(id)
      .run();
  }

  async deleteAnalysis(id: string, workspaceId: string): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM analyses WHERE id = ?1 AND workspace_id = ?2`)
      .bind(id, workspaceId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Jobs the cron sweep should pick up.
   *
   * Both branches are gated on `stalledBefore` so a job whose first attempt is
   * still in flight is never picked up twice: a `pending` row is only eligible
   * once it has sat unclaimed past the threshold, and a `running` row only once
   * its attempt has outlived it.
   */
  async findStalledAnalyses(
    stalledBefore: number,
    maxAttempts: number,
    limit = 10,
  ): Promise<AnalysisRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM analyses
         WHERE attempts < ?2
           AND (
             (status = 'pending' AND created_at < ?1)
             OR (status = 'running' AND started_at IS NOT NULL AND started_at < ?1)
           )
         ORDER BY created_at ASC
         LIMIT ?3`,
      )
      .bind(stalledBefore, maxAttempts, limit)
      .all<AnalysisRow>();
    return result.results ?? [];
  }

  /** Jobs that exhausted their retries and should be failed permanently. */
  async findExhaustedAnalyses(maxAttempts: number, limit = 25): Promise<AnalysisRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM analyses
         WHERE attempts >= ?1 AND status IN ('pending', 'running')
         ORDER BY created_at ASC LIMIT ?2`,
      )
      .bind(maxAttempts, limit)
      .all<AnalysisRow>();
    return result.results ?? [];
  }

  // ------------------------------------------------------------------- metrics
  async saveMetrics(row: Omit<MetricsRow, 'created_at'> & { created_at?: number }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO analysis_metrics
           (analysis_id, risk_score, risk_label, watermark_score, watermark_label,
            llm_score, llm_low, llm_high, llm_label, llm_model_id, llm_trained,
            language, word_count, payload_count, signal_count, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT (analysis_id) DO UPDATE SET
           risk_score = excluded.risk_score,
           risk_label = excluded.risk_label,
           watermark_score = excluded.watermark_score,
           watermark_label = excluded.watermark_label,
           llm_score = excluded.llm_score,
           llm_low = excluded.llm_low,
           llm_high = excluded.llm_high,
           llm_label = excluded.llm_label,
           llm_model_id = excluded.llm_model_id,
           llm_trained = excluded.llm_trained,
           language = excluded.language,
           word_count = excluded.word_count,
           payload_count = excluded.payload_count,
           signal_count = excluded.signal_count`,
      )
      .bind(
        row.analysis_id,
        row.risk_score,
        row.risk_label,
        row.watermark_score,
        row.watermark_label,
        row.llm_score,
        row.llm_low,
        row.llm_high,
        row.llm_label,
        row.llm_model_id,
        row.llm_trained,
        row.language,
        row.word_count,
        row.payload_count,
        row.signal_count,
        row.created_at ?? Date.now(),
      )
      .run();
  }

  async replaceSegments(analysisId: string, segments: Segment[]): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db.prepare(`DELETE FROM analysis_segments WHERE analysis_id = ?1`).bind(analysisId),
    ];
    for (const segment of segments) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO analysis_segments
               (analysis_id, idx, start_offset, end_offset, word_count,
                llm_likelihood, label, watermark_hits, preview)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
          )
          .bind(
            analysisId,
            segment.index,
            segment.start,
            segment.end,
            segment.word_count,
            segment.llm_likelihood,
            segment.label,
            segment.watermark_hits,
            segment.preview,
          ),
      );
    }
    await this.db.batch(statements);
  }

  async listSegments(analysisId: string): Promise<Segment[]> {
    const result = await this.db
      .prepare(
        `SELECT idx, start_offset, end_offset, word_count, llm_likelihood,
                label, watermark_hits, preview
         FROM analysis_segments WHERE analysis_id = ?1 ORDER BY idx ASC`,
      )
      .bind(analysisId)
      .all<{
        idx: number;
        start_offset: number;
        end_offset: number;
        word_count: number;
        llm_likelihood: number;
        label: string;
        watermark_hits: number;
        preview: string;
      }>();

    return (result.results ?? []).map((row) => ({
      index: row.idx,
      start: row.start_offset,
      end: row.end_offset,
      word_count: row.word_count,
      preview: row.preview,
      llm_likelihood: row.llm_likelihood,
      label: row.label as Segment['label'],
      watermark_hits: row.watermark_hits,
    }));
  }

  // ------------------------------------------------------------------- reports
  async createReport(row: {
    id: string;
    workspaceId: string;
    analysisId: string;
    title: string;
    notes: string | null;
    now?: number;
  }): Promise<Report> {
    const createdAt = row.now ?? Date.now();
    await this.db
      .prepare(
        `INSERT INTO reports (id, workspace_id, analysis_id, title, notes, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(row.id, row.workspaceId, row.analysisId, row.title, row.notes, createdAt)
      .run();
    return {
      id: row.id,
      analysis_id: row.analysisId,
      title: row.title,
      notes: row.notes,
      created_at: createdAt,
    };
  }

  async listReports(
    workspaceId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: Report[]; total: number }> {
    const [list, count] = await Promise.all([
      this.db
        .prepare(
          `SELECT id, analysis_id, title, notes, created_at FROM reports
           WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT ?2 OFFSET ?3`,
        )
        .bind(workspaceId, limit, offset)
        .all<Report>(),
      this.db
        .prepare(`SELECT COUNT(*) AS total FROM reports WHERE workspace_id = ?1`)
        .bind(workspaceId)
        .first<{ total: number }>(),
    ]);
    return { items: list.results ?? [], total: count?.total ?? 0 };
  }

  async getReport(id: string, workspaceId: string): Promise<Report | null> {
    return (
      (await this.db
        .prepare(
          `SELECT id, analysis_id, title, notes, created_at FROM reports
           WHERE id = ?1 AND workspace_id = ?2`,
        )
        .bind(id, workspaceId)
        .first<Report>()) ?? null
    );
  }

  async deleteReport(id: string, workspaceId: string): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM reports WHERE id = ?1 AND workspace_id = ?2`)
      .bind(id, workspaceId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  // -------------------------------------------------------------------- events
  async recordEvent(
    type: string,
    detail: string | null,
    workspaceId: string | null,
    analysisId: string | null,
    now = Date.now(),
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO events (workspace_id, analysis_id, type, detail, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(workspaceId, analysisId, type, detail?.slice(0, 1000) ?? null, now)
      .run();
  }

  // --------------------------------------------------------------------- stats
  async stats(workspaceId: string, now = Date.now()): Promise<Stats> {
    const sevenDaysAgo = now - 7 * 86_400_000;

    const [statusRows, aggregates, daily] = await Promise.all([
      this.db
        .prepare(
          `SELECT status, COUNT(*) AS count FROM analyses WHERE workspace_id = ?1 GROUP BY status`,
        )
        .bind(workspaceId)
        .all<{ status: AnalysisStatus; count: number }>(),
      this.db
        .prepare(
          `SELECT
             COUNT(*) AS total,
             AVG(m.risk_score) AS average_risk,
             SUM(CASE WHEN m.watermark_label IN ('payload_recovered', 'watermark_detected')
                      THEN 1 ELSE 0 END) AS watermarks,
             SUM(CASE WHEN m.payload_count > 0 THEN 1 ELSE 0 END) AS payloads
           FROM analysis_metrics m
           JOIN analyses a ON a.id = m.analysis_id
           WHERE a.workspace_id = ?1`,
        )
        .bind(workspaceId)
        .first<{
          total: number;
          average_risk: number | null;
          watermarks: number | null;
          payloads: number | null;
        }>(),
      this.db
        .prepare(
          `SELECT date(created_at / 1000, 'unixepoch') AS date, COUNT(*) AS count
           FROM analyses WHERE workspace_id = ?1 AND created_at >= ?2
           GROUP BY date ORDER BY date ASC`,
        )
        .bind(workspaceId, sevenDaysAgo)
        .all<{ date: string; count: number }>(),
    ]);

    const byStatus: Record<AnalysisStatus, number> = {
      pending: 0,
      running: 0,
      done: 0,
      error: 0,
    };
    for (const row of statusRows.results ?? []) {
      byStatus[row.status] = row.count;
    }

    return {
      total: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
      by_status: byStatus,
      watermarks_detected: aggregates?.watermarks ?? 0,
      payloads_recovered: aggregates?.payloads ?? 0,
      average_risk:
        aggregates?.average_risk === null || aggregates?.average_risk === undefined
          ? null
          : Math.round(aggregates.average_risk * 10_000) / 10_000,
      last_7_days: daily.results ?? [],
    };
  }
}
