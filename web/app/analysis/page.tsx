'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnalysisMode, Capabilities } from '@wf/shared';
import { api, ApiRequestError } from '@/lib/api';
import { countWords, estimateTokens, formatBytes } from '@/lib/format';

type Source = 'text' | 'file';

export default function NewAnalysisPage() {
  const router = useRouter();
  const [source, setSource] = useState<Source>('text');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<AnalysisMode>('forensic');
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .capabilities(controller.signal)
      .then(setCapabilities)
      .catch(() => {
        /* the form still works; limits fall back to the server's own checks */
      });
    return () => controller.abort();
  }, []);

  const maxChars = capabilities?.max_chars ?? 200_000;
  const maxUpload = capabilities?.max_upload_bytes ?? 10 * 1024 * 1024;
  const stats = useMemo(
    () => ({ chars: text.length, words: countWords(text), tokens: estimateTokens(text) }),
    [text],
  );

  const overLimit = stats.chars > maxChars;
  const canSubmit =
    !busy && (source === 'text' ? text.trim().length > 0 && !overLimit : file !== null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;

    setBusy(true);
    setError(null);

    try {
      let uploadId: string | undefined;
      if (source === 'file' && file) {
        setStatus(`Uploading ${file.name}…`);
        const upload = await api.upload(file);
        uploadId = upload.upload_id;
      }

      setStatus('Submitting for analysis…');
      const created = await api.createAnalysis(
        source === 'file' ? { uploadId, mode } : { text, mode },
      );

      router.push(`/analysis/result/?id=${created.id}`);
    } catch (caught) {
      setBusy(false);
      setStatus('');
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Something went wrong. Check the API base URL on the Settings page.',
      );
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">New analysis</h1>
        <p className="mt-1 text-sm text-muted">
          Paste text or upload a document. Nothing leaves your workspace except the text itself,
          which is sent to the analysis engine and stored so you can revisit the result.
        </p>
      </header>

      <form className="space-y-6" onSubmit={submit}>
        <div className="card">
          <div role="tablist" aria-label="Input type" className="flex gap-2">
            {(['text', 'file'] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={source === option}
                onClick={() => setSource(option)}
                className={`btn ${source === option ? 'border-accent text-accent' : 'btn-ghost'}`}
              >
                {option === 'text' ? 'Paste text' : 'Upload file'}
              </button>
            ))}
          </div>

          {source === 'text' ? (
            <div className="mt-4">
              <label className="label" htmlFor="analysis-text">
                Text to analyse
              </label>
              <textarea
                id="analysis-text"
                className="input mt-1 min-h-[18rem] font-mono text-[13px]"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Paste the document here. Invisible characters are preserved exactly as pasted — that is what makes the covert-channel detection work."
                spellCheck={false}
              />
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                <span className={`hint tabular-nums ${overLimit ? 'text-danger' : ''}`}>
                  {stats.chars.toLocaleString()} / {maxChars.toLocaleString()} characters
                </span>
                <span className="hint tabular-nums">{stats.words.toLocaleString()} words</span>
                <span className="hint tabular-nums">
                  ~{stats.tokens.toLocaleString()} tokens (estimate)
                </span>
                {stats.words > 0 && stats.words < 150 ? (
                  <span className="hint text-warn">
                    Below 150 words the style score is pulled towards 50% — covert-channel
                    detection still works normally.
                  </span>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <label className="label" htmlFor="analysis-file">
                Document
              </label>
              <input
                id="analysis-file"
                ref={fileInput}
                type="file"
                className="input mt-1"
                accept={capabilities?.supported_uploads?.join(',') ?? '.txt,.md,.pdf,.docx,.html'}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
              <p className="hint mt-2">
                Up to {formatBytes(maxUpload)}. Accepted:{' '}
                {(capabilities?.supported_uploads ?? ['.txt', '.md', '.pdf', '.docx', '.html']).join(
                  ', ',
                )}
                . Text is extracted by the engine; scanned PDFs without a text layer cannot be read.
              </p>
              {file ? (
                <p className="hint mt-2">
                  Selected: {file.name} ({formatBytes(file.size)})
                  {file.size > maxUpload ? (
                    <span className="text-danger"> — over the size limit</span>
                  ) : null}
                </p>
              ) : null}
            </div>
          )}
        </div>

        <fieldset className="card">
          <legend className="text-base font-semibold">Analysis mode</legend>
          <div className="mt-3 space-y-3">
            <ModeOption
              value="quick"
              checked={mode === 'quick'}
              onChange={setMode}
              title="Quick"
              description="Covert-channel detection plus stylometry with coarse segmentation. Fast; enough to triage a document."
            />
            <ModeOption
              value="forensic"
              checked={mode === 'forensic'}
              onChange={setMode}
              title="Full forensic"
              description="Fine-grained segmentation for the heatmap, style-resemblance profiles and, where the engine has it enabled, local language-model surprisal."
            />
          </div>
        </fieldset>

        {error ? (
          <div className="card border-danger/40">
            <p className="text-sm text-danger">{error}</p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-4">
          <button type="submit" className="btn-primary" disabled={!canSubmit}>
            {busy ? 'Working…' : 'Analyse'}
          </button>
          {status ? <span className="text-sm text-muted">{status}</span> : null}
          {capabilities && !capabilities.engine_reachable ? (
            <span className="text-sm text-warn">
              The engine is asleep — the first analysis can take up to a minute to wake it.
            </span>
          ) : null}
        </div>
      </form>
    </div>
  );
}

function ModeOption({
  value,
  checked,
  onChange,
  title,
  description,
}: {
  value: AnalysisMode;
  checked: boolean;
  onChange: (mode: AnalysisMode) => void;
  title: string;
  description: string;
}) {
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-md border p-3 ${
        checked ? 'border-accent bg-accent/5' : 'border-border'
      }`}
    >
      <input
        type="radio"
        name="mode"
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className="mt-1"
      />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="hint mt-0.5 block">{description}</span>
      </span>
    </label>
  );
}
