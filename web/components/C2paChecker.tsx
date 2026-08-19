'use client';

import { useRef, useState } from 'react';
import type { C2paResult } from '@wf/shared';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/format';

/**
 * Integrity and trust are rendered as two separate rows on purpose.
 *
 * A single green tick for a valid signature would be a forger's dream: anyone
 * can issue a certificate whose common name reads "Adobe Inc." and sign a file
 * with it. The signature then verifies perfectly while the claimed origin is
 * fiction. So the page never shows "verified" without also showing whether the
 * signer is recognised.
 */
const INTEGRITY_TEXT: Record<C2paResult['integrity'], { label: string; tone: string }> = {
  intact: { label: 'Intact — the file matches what was signed', tone: 'text-ok' },
  broken: { label: 'Broken — the file changed after signing', tone: 'text-danger' },
  unknown: { label: 'Not established', tone: 'text-muted' },
};

const TRUST_TEXT: Record<C2paResult['trust'], { label: string; tone: string }> = {
  recognised: { label: 'Signer is on a recognised trust list', tone: 'text-ok' },
  unrecognised: {
    label: 'Signer is not recognised — the claimed origin is unverified',
    tone: 'text-warn',
  },
  unknown: { label: 'Not established', tone: 'text-muted' },
};

export function C2paChecker() {
  const [result, setResult] = useState<C2paResult | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function check(file: File) {
    setBusy(true);
    setError(null);
    setName(`${file.name} · ${formatBytes(file.size)}`);
    try {
      setResult(await api.c2pa(file));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read the file');
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="c2pa-heading">
      <h2 id="c2pa-heading" className="text-base font-semibold">
        Check content credentials (C2PA)
      </h2>
      <p className="mt-2 text-sm text-muted">
        Reads the signed provenance manifest some tools attach to a file — PDFs, images, audio
        and video. Unlike the sampling watermark, this needs no secret key, so it can be
        verified here. Nothing is stored.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          ref={input}
          type="file"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void check(file);
          }}
        />
        <button
          type="button"
          className="btn-secondary"
          onClick={() => input.current?.click()}
          disabled={busy}
        >
          {busy ? 'Reading…' : 'Choose a file'}
        </button>
        {name ? <span className="text-xs text-muted">{name}</span> : null}
      </div>

      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}

      {result && !result.present ? (
        <div className="mt-4 rounded-md border border-line bg-surface p-3 text-sm">
          <p className="font-medium">No content credential</p>
          <p className="mt-1 text-muted">{result.reason}</p>
          <p className="mt-2 text-xs text-muted">
            This says nothing about how the file was made. Most files carry no credential, and
            saving or converting one usually strips it.
          </p>
        </div>
      ) : null}

      {result?.present ? (
        <div className="mt-4 space-y-3 text-sm">
          <dl className="space-y-2">
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted">Integrity</dt>
              <dd className={INTEGRITY_TEXT[result.integrity].tone}>
                {INTEGRITY_TEXT[result.integrity].label}
              </dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted">Trust</dt>
              <dd className={TRUST_TEXT[result.trust].tone}>{TRUST_TEXT[result.trust].label}</dd>
            </div>
            {result.generator ? (
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted">Produced by (claimed)</dt>
                <dd>{result.generator}</dd>
              </div>
            ) : null}
            {result.signer_common_name ? (
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted">Signed by (claimed)</dt>
                <dd>
                  {result.signer_common_name}
                  {result.signature_alg ? ` · ${result.signature_alg}` : ''}
                </dd>
              </div>
            ) : null}
            {result.ai_declared !== null ? (
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted">Declares AI authorship</dt>
                <dd className={result.ai_declared ? 'text-warn' : ''}>
                  {result.ai_declared ? 'Yes' : 'No'}
                </dd>
              </div>
            ) : null}
          </dl>

          {result.notes.map((note) => (
            <p
              key={note}
              className="rounded-md border border-warn/30 bg-warn/10 p-3 text-warn"
            >
              {note}
            </p>
          ))}

          {result.actions.length > 0 ? (
            <p className="text-xs text-muted">Recorded actions: {result.actions.join(', ')}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
