'use client';

import { useState } from 'react';
import type { SanitizeLevel, SanitizeResult } from '@wf/shared';
import { api } from '@/lib/api';

interface SanitizePanelProps {
  text: string;
  filename: string | null;
}

const LEVEL_NOTE: Record<SanitizeLevel, string> = {
  safe:
    'Keeps invisible characters this document genuinely needs — emoji joiners, the joiners Arabic and Indic scripts spell words with, CJK variation selectors — and lists every one it kept.',
  aggressive:
    'Removes every invisible character. Nothing can hide, but emoji sequences and non-Latin words may come out altered. Use it on plain English, or when you have checked the safe result first.',
};

export function SanitizePanel({ text, filename }: SanitizePanelProps) {
  const [level, setLevel] = useState<SanitizeLevel>('safe');
  const [normalizeHomoglyphs, setNormalizeHomoglyphs] = useState(false);
  const [result, setResult] = useState<SanitizeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setResult(await api.sanitize({ text, level, normalizeHomoglyphs }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sanitise the document');
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!result) return;
    const base = (filename ?? 'document.txt').replace(/\.[^.]+$/, '');
    const blob = new Blob([result.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${base}.clean.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function copy() {
    if (!result) return;
    await navigator.clipboard.writeText(result.text);
    setCopied(true);
  }

  return (
    <section className="card" aria-labelledby="sanitize-heading">
      <h2 id="sanitize-heading" className="text-base font-semibold">
        Clean this document
      </h2>
      <p className="mt-2 text-sm text-muted">
        Removes the carrier characters so the document can be passed on without the mark.
        Nothing is stored: the cleaned text is returned to your browser and never written to
        the database.
      </p>

      <fieldset className="mt-4">
        <legend className="sr-only">Sanitisation level</legend>
        <div className="flex flex-wrap gap-2">
          {(['safe', 'aggressive'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                setLevel(option);
                setResult(null);
              }}
              aria-pressed={level === option}
              className={`badge ${level === option ? 'bg-accent/20 text-accent' : ''}`}
            >
              {option}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">{LEVEL_NOTE[level]}</p>
      </fieldset>

      <label className="mt-4 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={normalizeHomoglyphs}
          onChange={(event) => {
            setNormalizeHomoglyphs(event.target.checked);
            setResult(null);
          }}
          className="mt-1"
        />
        <span>
          Also rewrite look-alike letters to Latin
          <span className="block text-xs text-muted">
            Only where a non-Latin letter sits inside an otherwise-Latin word. A genuinely
            Cyrillic or Greek word is left alone.
          </span>
        </span>
      </label>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="btn-primary" onClick={run} disabled={busy}>
          {busy ? 'Cleaning…' : 'Clean document'}
        </button>
        {result ? (
          <>
            <button type="button" className="btn-secondary" onClick={download}>
              Download .clean.txt
            </button>
            <button type="button" className="btn-secondary" onClick={copy}>
              {copied ? 'Copied' : 'Copy text'}
            </button>
          </>
        ) : null}
      </div>

      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}

      {result ? (
        <div className="mt-5 space-y-3">
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Removed</dt>
              <dd className="text-lg font-semibold">{result.removed_total}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Replaced</dt>
              <dd className="text-lg font-semibold">{result.replaced_total}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Kept on purpose</dt>
              <dd className="text-lg font-semibold">{result.preserved_total}</dd>
            </div>
          </dl>

          {result.warnings.map((warning) => (
            <p
              key={warning}
              className="rounded-md border border-warn/30 bg-warn/10 p-3 text-sm text-warn"
            >
              {warning}
            </p>
          ))}

          {!result.changed ? (
            <p className="text-sm text-muted">
              Nothing to remove — this document carries no covert-channel characters.
            </p>
          ) : null}

          {result.preserved.length > 0 ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted">
                What was kept, and why ({result.preserved.length})
              </summary>
              <ul className="mt-2 space-y-1">
                {result.preserved.slice(0, 25).map((kept) => (
                  <li key={`${kept.offset}-${kept.codepoint}`} className="text-muted">
                    <code>{kept.codepoint}</code> at {kept.offset} — {kept.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
