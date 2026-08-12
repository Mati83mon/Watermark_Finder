'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { Report } from '@wf/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatDate } from '@/lib/format';

export default function ReportsPage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      const list = await api.listReports({ limit: 50 }, signal);
      setReports(list.items);
      setTotal(list.total);
    } catch (caught) {
      if (signal?.aborted) return;
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not load reports.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const remove = async (id: string) => {
    const previous = reports;
    setReports((current) => current.filter((report) => report.id !== id));
    setTotal((current) => Math.max(0, current - 1));
    try {
      await api.deleteReport(id);
    } catch {
      // Roll the optimistic removal back so the list keeps matching the server.
      setReports(previous);
      setTotal(previous.length);
      setError('Could not delete that report.');
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="mt-1 text-sm text-muted">
          Analyses you saved for later, with your own title and notes.
        </p>
      </header>

      {error ? (
        <div className="card border-danger/40">
          <p className="text-sm text-danger">{error}</p>
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : reports.length === 0 ? (
        <div className="card">
          <p className="text-sm text-muted">
            No saved reports yet. Open a completed analysis and use “Save as a report”.
          </p>
          <Link href="/analysis/" className="link mt-2 inline-block">
            New analysis →
          </Link>
        </div>
      ) : (
        <>
          <p className="hint">{total} report(s)</p>
          <ul className="space-y-3">
            {reports.map((report) => (
              <li key={report.id} className="card">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-medium">{report.title}</h2>
                    <p className="hint mt-1">
                      {formatDate(report.created_at)} · analysis{' '}
                      <span className="font-mono">{report.analysis_id}</span>
                    </p>
                    {report.notes ? (
                      <p className="mt-2 whitespace-pre-wrap text-sm">{report.notes}</p>
                    ) : null}
                  </div>
                  <div className="flex gap-2">
                    <Link href={`/analysis/result/?id=${report.analysis_id}`} className="btn-ghost">
                      Open analysis
                    </Link>
                    <button
                      type="button"
                      className="btn-danger"
                      onClick={() => void remove(report.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
