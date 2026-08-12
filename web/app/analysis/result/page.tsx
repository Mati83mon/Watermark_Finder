'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import type { AnalysisDetail, Segment } from '@wf/shared';
import { api, ApiRequestError, pollAnalysis } from '@/lib/api';
import { statusText } from '@/lib/format';
import { ResultView } from '@/components/ResultView';

export default function ResultPage() {
  // `useSearchParams` needs a Suspense boundary in a statically exported app.
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <ResultPageInner />
    </Suspense>
  );
}

function ResultPageInner() {
  const params = useSearchParams();
  const id = params.get('id');

  const [analysis, setAnalysis] = useState<AnalysisDetail | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState('Loading…');

  const load = useCallback(
    async (analysisId: string, signal: AbortSignal) => {
      setError(null);
      try {
        const settled = await pollAnalysis(analysisId, {
          signal,
          onUpdate: (update) => {
            setAnalysis(update);
            setProgress(
              update.status === 'pending'
                ? 'Queued — waking the analysis engine if it was asleep…'
                : update.status === 'running'
                  ? 'Analysing…'
                  : '',
            );
          },
        });

        if (signal.aborted) return;
        setAnalysis(settled);

        if (settled.status === 'done') {
          // Segments and source text power the heatmap; neither is fatal if
          // missing, so failures here degrade the view rather than break it.
          const [segmentResult, textResult] = await Promise.allSettled([
            api.getSegments(analysisId, signal),
            api.getText(analysisId, signal),
          ]);
          if (segmentResult.status === 'fulfilled') setSegments(segmentResult.value.items);
          if (textResult.status === 'fulfilled') setText(textResult.value.text);
        }
      } catch (caught) {
        if (signal.aborted) return;
        setError(
          caught instanceof ApiRequestError ? caught.message : 'Could not load this analysis.',
        );
      }
    },
    [],
  );

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    void load(id, controller.signal);
    return () => controller.abort();
  }, [id, load]);

  if (!id) {
    return (
      <div className="card">
        <p className="text-sm">No analysis id in the URL.</p>
        <Link href="/analysis/" className="link mt-2 inline-block">
          Start a new analysis →
        </Link>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card border-danger/40">
        <p className="text-sm text-danger">{error}</p>
        <Link href="/" className="link mt-3 inline-block">
          Back to the dashboard →
        </Link>
      </div>
    );
  }

  if (!analysis) {
    return <p className="text-sm text-muted">{progress}</p>;
  }

  if (analysis.status === 'error') {
    return (
      <div className="card border-danger/40">
        <h1 className="text-lg font-semibold text-danger">Analysis failed</h1>
        <p className="mt-2 text-sm">{analysis.error ?? 'The engine did not return a result.'}</p>
        <p className="hint mt-2">
          Attempts: {analysis.attempts}. A failed analysis is retried automatically for a while
          before it is given up on.
        </p>
        <Link href="/analysis/" className="link mt-3 inline-block">
          Try again →
        </Link>
      </div>
    );
  }

  if (analysis.status !== 'done') {
    return (
      <div className="card">
        <h1 className="text-lg font-semibold">{statusText(analysis.status)}</h1>
        <p className="mt-2 text-sm text-muted">{progress}</p>
        <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-border">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
        </div>
        <p className="hint mt-3">
          This page keeps polling. The analysis continues in the background even if you close it.
        </p>
      </div>
    );
  }

  return <ResultView analysis={analysis} text={text} segments={segments} />;
}
