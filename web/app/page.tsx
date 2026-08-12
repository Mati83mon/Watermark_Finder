'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { AnalysisSummary, Stats } from '@wf/shared';
import { WATERMARK_LABEL_TEXT } from '@wf/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatDate, percent, RISK_CLASSES, statusText, truncate } from '@/lib/format';

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [analyses, setAnalyses] = useState<AnalysisSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      const [statsResult, list] = await Promise.all([
        api.stats(signal),
        api.listAnalyses({ limit: 10 }, signal),
      ]);
      setStats(statsResult);
      setAnalyses(list.items);
    } catch (caught) {
      if (signal?.aborted) return;
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not reach the API. Check the base URL on the Settings page.',
      );
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="mt-1 text-sm text-muted">
            Recent analyses from this workspace, held anonymously in your browser.
          </p>
        </div>
        <Link href="/analysis/" className="btn-primary">
          New analysis
        </Link>
      </section>

      {error ? (
        <div className="card border-danger/40">
          <p className="text-sm text-danger">{error}</p>
          <button type="button" className="btn-ghost mt-3" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      <section aria-label="Summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Analyses" value={stats ? String(stats.total) : '—'} />
        <StatTile
          label="Watermarks detected"
          value={stats ? String(stats.watermarks_detected) : '—'}
          tone={stats && stats.watermarks_detected > 0 ? 'danger' : 'neutral'}
        />
        <StatTile
          label="Payloads recovered"
          value={stats ? String(stats.payloads_recovered) : '—'}
          tone={stats && stats.payloads_recovered > 0 ? 'danger' : 'neutral'}
        />
        <StatTile
          label="Average risk"
          value={stats?.average_risk === null || stats === null ? '—' : percent(stats.average_risk)}
        />
      </section>

      {stats && stats.last_7_days.length > 0 ? <ActivityStrip stats={stats} /> : null}

      <section aria-labelledby="recent-heading" className="card">
        <h2 id="recent-heading" className="text-base font-semibold">
          Recent analyses
        </h2>

        {loading ? (
          <p className="mt-4 text-sm text-muted">Loading…</p>
        ) : analyses.length === 0 ? (
          <div className="mt-4 text-sm text-muted">
            <p>Nothing analysed yet.</p>
            <Link href="/analysis/" className="link mt-2 inline-block">
              Run your first analysis →
            </Link>
          </div>
        ) : (
          <div className="scroll-x mt-4">
            <table className="w-full min-w-[46rem] border-collapse text-left">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="table-cell">Created</th>
                  <th className="table-cell">Source</th>
                  <th className="table-cell">Status</th>
                  <th className="table-cell">Risk</th>
                  <th className="table-cell">Watermark</th>
                  <th className="table-cell">Style</th>
                  <th className="table-cell" />
                </tr>
              </thead>
              <tbody>
                {analyses.map((analysis) => (
                  <tr key={analysis.id} className="border-b border-border/60">
                    <td className="table-cell whitespace-nowrap text-muted">
                      {formatDate(analysis.created_at)}
                    </td>
                    <td className="table-cell">
                      {analysis.filename ? truncate(analysis.filename, 28) : 'Pasted text'}
                      <span className="hint block">{analysis.char_count} chars · {analysis.mode}</span>
                    </td>
                    <td className="table-cell">{statusText(analysis.status)}</td>
                    <td className="table-cell">
                      {analysis.risk_label ? (
                        <span className={`badge ${RISK_CLASSES[analysis.risk_label]}`}>
                          {percent(analysis.risk_score)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="table-cell text-sm">
                      {analysis.watermark_label
                        ? WATERMARK_LABEL_TEXT[analysis.watermark_label]
                        : '—'}
                    </td>
                    <td className="table-cell tabular-nums">{percent(analysis.llm_score)}</td>
                    <td className="table-cell">
                      <Link href={`/analysis/result/?id=${analysis.id}`} className="link">
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function StatTile({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <div className="card">
      <p className="text-sm text-muted">{label}</p>
      <p
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          tone === 'danger' ? 'text-danger' : ''
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function ActivityStrip({ stats }: { stats: Stats }) {
  const max = Math.max(...stats.last_7_days.map((day) => day.count), 1);

  return (
    <section aria-labelledby="activity-heading" className="card">
      <h2 id="activity-heading" className="text-base font-semibold">
        Last 7 days
      </h2>
      <ul className="mt-4 flex items-end gap-3">
        {stats.last_7_days.map((day) => (
          <li key={day.date} className="flex flex-1 flex-col items-center gap-1.5">
            <span className="hint tabular-nums">{day.count}</span>
            <span
              className="w-full rounded-t bg-accent/70"
              style={{ height: `${Math.max(4, (day.count / max) * 72)}px` }}
              aria-hidden
            />
            <span className="hint">{day.date.slice(5)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
