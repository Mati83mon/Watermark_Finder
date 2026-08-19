'use client';

import { useState } from 'react';
import type { AnalysisDetail, Segment } from '@wf/shared';
import { STYLE_LABEL_TEXT, WATERMARK_BASIS_NOTE, WATERMARK_LABEL_TEXT } from '@wf/shared';
import { api } from '@/lib/api';
import { formatDate, percent, RISK_CLASSES } from '@/lib/format';
import { FindingList, SignalList } from '@/components/SignalList';
import { ScoreCard } from '@/components/ScoreCard';
import { SanitizePanel } from '@/components/SanitizePanel';
import { TextHeatmap } from '@/components/TextHeatmap';

interface ResultViewProps {
  analysis: AnalysisDetail;
  text: string | null;
  segments: Segment[];
}

export function ResultView({ analysis, text, segments }: ResultViewProps) {
  const result = analysis.result;

  if (!result) {
    return (
      <div className="card">
        <p className="text-sm">
          This analysis has no stored result. It may have been created by an older build, or the
          result document may have been removed from storage.
        </p>
      </div>
    );
  }

  const { scores } = result;
  const watermarkTone =
    scores.watermark.value >= 0.8 ? 'danger' : scores.watermark.value >= 0.5 ? 'warn' : 'ok';
  const styleTone =
    scores.llm_likelihood.value >= 0.75
      ? 'danger'
      : scores.llm_likelihood.value >= 0.55
        ? 'warn'
        : 'ok';

  return (
    <div className="space-y-6">
      <header className="card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Analysis {analysis.id}</h1>
            <p className="hint mt-1">
              {formatDate(analysis.created_at)} · mode {analysis.mode} ·{' '}
              {analysis.filename ?? 'pasted text'} · {result.input.words} words ·{' '}
              {result.input.language}
            </p>
            <p className="hint mt-1 break-all font-mono">sha256 {analysis.text_sha256}</p>
          </div>
          <span className={`badge ${RISK_CLASSES[scores.risk.label]}`}>
            risk {percent(scores.risk.value)} · {scores.risk.label}
          </span>
        </div>

        {result.warnings.length > 0 ? (
          <ul className="mt-4 space-y-1.5 rounded-md border border-warn/30 bg-warn/10 p-3 text-sm text-warn">
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <ScoreCard
          title="Watermark / covert channel"
          value={scores.watermark.value}
          label={WATERMARK_LABEL_TEXT[scores.watermark.label]}
          confidence={scores.watermark.confidence}
          tone={watermarkTone}
          footnote={WATERMARK_BASIS_NOTE[scores.watermark.basis ?? 'none']}
        />
        <ScoreCard
          title="Assistant-register style"
          value={scores.llm_likelihood.value}
          low={scores.llm_likelihood.low}
          high={scores.llm_likelihood.high}
          label={STYLE_LABEL_TEXT[scores.llm_likelihood.label]}
          confidence={scores.llm_likelihood.confidence}
          tone={styleTone}
          footnote={`Probabilistic · model ${scores.llm_likelihood.model_id}${
            scores.llm_likelihood.trained ? '' : ' (documented prior, not corpus-fitted)'
          }`}
        />
      </div>

      {result.payloads.length > 0 ? (
        <section className="card border-danger/40" aria-labelledby="payloads-heading">
          <h2 id="payloads-heading" className="text-base font-semibold text-danger">
            Recovered hidden payloads ({result.payloads.length})
          </h2>
          <ul className="mt-4 space-y-4">
            {result.payloads.map((payload) => (
              <li key={payload.channel}>
                <p className="text-sm font-medium">
                  {payload.channel.replace(/_/g, ' ')} · {payload.byte_length} bytes ·{' '}
                  {payload.carrier_count} carrier characters
                </p>
                <pre className="scroll-x mt-2 rounded-md border border-border bg-surface p-3 font-mono text-xs">
                  {payload.text}
                </pre>
                <p className="hint mt-1">
                  offsets {payload.first_offset}–{payload.last_offset} · {payload.note}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <FindingList findings={result.findings} />

      {text ? <SanitizePanel text={text} filename={analysis.filename} /> : null}

      {text ? (
        <TextHeatmap text={text} segments={segments} signals={result.signals} />
      ) : (
        <div className="card">
          <p className="text-sm text-muted">
            The source text is no longer stored, so the document view is unavailable.
          </p>
        </div>
      )}

      <SignalList signals={result.signals} />

      <StyleDetails analysis={analysis} />

      <TechnicalReport markdown={result.technical_report_markdown} analysisId={analysis.id} />

      <SaveReport analysisId={analysis.id} />
    </div>
  );
}

function StyleDetails({ analysis }: { analysis: AnalysisDetail }) {
  const result = analysis.result!;
  const style = result.scores.llm_likelihood;
  const profiles = result.style_profiles.matches;

  return (
    <section className="card" aria-labelledby="style-heading">
      <h2 id="style-heading" className="text-base font-semibold">
        How the style score was reached
      </h2>

      {style.notes.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm text-muted">
          {style.notes.map((note) => (
            <li key={note}>· {note}</li>
          ))}
        </ul>
      ) : null}

      {style.contributions.length > 0 ? (
        <div className="scroll-x mt-4">
          <table className="w-full min-w-[40rem] border-collapse text-left">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="table-cell">Feature</th>
                <th className="table-cell">Value</th>
                <th className="table-cell">z</th>
                <th className="table-cell">Points towards</th>
                <th className="table-cell">Why it is measured</th>
              </tr>
            </thead>
            <tbody>
              {style.contributions.map((contribution) => (
                <tr key={contribution.feature} className="border-b border-border/60">
                  <td className="table-cell font-mono text-xs">{contribution.feature}</td>
                  <td className="table-cell tabular-nums">{contribution.value.toFixed(3)}</td>
                  <td className="table-cell tabular-nums">{contribution.z.toFixed(2)}</td>
                  <td className="table-cell">
                    <span
                      className={`badge ${
                        contribution.direction === 'assistant'
                          ? 'border-danger/30 bg-danger/10 text-danger'
                          : 'border-ok/30 bg-ok/10 text-ok'
                      }`}
                    >
                      {contribution.direction}
                    </span>
                  </td>
                  <td className="table-cell text-xs text-muted">{contribution.rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {profiles.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold">Style resemblance</h3>
          <p className="hint mt-1">{result.style_profiles.disclaimer}</p>
          <ul className="mt-3 space-y-2">
            {profiles.map((profile) => (
              <li key={profile.family} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="w-16 shrink-0 tabular-nums text-muted">
                  {percent(profile.similarity)}
                </span>
                <span className="font-medium">{profile.label}</span>
                <span className="text-xs text-muted">{profile.rationale}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.perplexity.available ? (
        <p className="hint mt-4">
          Local surprisal from {result.perplexity.model}: mean{' '}
          {result.perplexity.mean_surprisal} nats/token, burstiness{' '}
          {result.perplexity.surprisal_cv}.
        </p>
      ) : null}
    </section>
  );
}

function TechnicalReport({ markdown, analysisId }: { markdown: string; analysisId: string }) {
  const download = () => {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `watermark-finder-${analysisId}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="card" aria-labelledby="report-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="report-heading" className="text-base font-semibold">
          Technical report
        </h2>
        <div className="no-print flex gap-2">
          <button type="button" className="btn-ghost" onClick={download}>
            Download .md
          </button>
          <button type="button" className="btn-ghost" onClick={() => window.print()}>
            Print / PDF
          </button>
        </div>
      </div>
      <pre className="scroll-x mt-4 max-h-[36rem] overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-surface p-4 font-mono text-xs leading-relaxed">
        {markdown}
      </pre>
    </section>
  );
}

function SaveReport({ analysisId }: { analysisId: string }) {
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    setState('saving');
    try {
      await api.createReport({ analysisId, title: title.trim(), notes: notes.trim() || undefined });
      setState('saved');
      setMessage('Saved to Reports.');
      setTitle('');
      setNotes('');
    } catch (error) {
      setState('error');
      setMessage(error instanceof Error ? error.message : 'Could not save the report.');
    }
  };

  return (
    <section className="card no-print" aria-labelledby="save-heading">
      <h2 id="save-heading" className="text-base font-semibold">
        Save as a report
      </h2>
      <form className="mt-3 space-y-3" onSubmit={submit}>
        <div>
          <label className="label" htmlFor="report-title">
            Title
          </label>
          <input
            id="report-title"
            className="input mt-1"
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. Supplier contract, October review"
          />
        </div>
        <div>
          <label className="label" htmlFor="report-notes">
            Notes <span className="hint">(optional)</span>
          </label>
          <textarea
            id="report-notes"
            className="input mt-1 min-h-[5rem]"
            value={notes}
            maxLength={5000}
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" className="btn-primary" disabled={state === 'saving' || !title.trim()}>
            {state === 'saving' ? 'Saving…' : 'Save report'}
          </button>
          {message ? (
            <span className={`text-sm ${state === 'error' ? 'text-danger' : 'text-ok'}`}>
              {message}
            </span>
          ) : null}
        </div>
      </form>
    </section>
  );
}
