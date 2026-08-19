'use client';

import { useState } from 'react';
import type { MarkChannel, MarkResult } from '@wf/shared';
import { MARK_CHANNEL_NOTE } from '@wf/shared';
import { api } from '@/lib/api';
import { countWords } from '@/lib/format';

const CHANNELS: MarkChannel[] = ['tag_characters', 'variation_selectors', 'zero_width_binary'];

export default function ProtectPage() {
  const [text, setText] = useState('');
  const [recipientList, setRecipientList] = useState('');
  const [template, setTemplate] = useState('WF-{index:03d}');
  const [channel, setChannel] = useState<MarkChannel>('tag_characters');
  const [repeat, setRepeat] = useState(2);
  const [result, setResult] = useState<MarkResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recipients = recipientList
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
  const duplicates = recipients.length !== new Set(recipients).size;
  const ready = text.trim().length > 0 && recipients.length > 0 && !duplicates;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await api.mark({ text, recipients, template, channel, repeat }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not mark the document');
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  function downloadAll() {
    if (!result) return;
    for (const copy of result.copies) {
      const blob = new Blob([copy.text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${copy.recipient.replace(/[^\w.-]+/g, '_')}.txt`;
      link.click();
      URL.revokeObjectURL(url);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Protect a document</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Produces one copy per recipient, each carrying a different invisible mark. The copies
          read identically. If one surfaces where it should not, analyse it here and the mark
          names the copy it came from.
        </p>
      </header>

      <form onSubmit={submit} className="space-y-6">
        <section className="card">
          <label htmlFor="doc" className="text-sm font-medium">
            Document
          </label>
          <textarea
            id="doc"
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={10}
            className="mt-2 w-full rounded-md border border-line bg-surface p-3 font-mono text-sm"
            placeholder="Paste the confidential draft here."
          />
          <p className="mt-2 text-xs text-muted">{countWords(text)} words</p>
        </section>

        <section className="card space-y-4">
          <div>
            <label htmlFor="recipients" className="text-sm font-medium">
              Recipients
            </label>
            <textarea
              id="recipients"
              value={recipientList}
              onChange={(event) => setRecipientList(event.target.value)}
              rows={4}
              className="mt-2 w-full rounded-md border border-line bg-surface p-3 text-sm"
              placeholder={'Jan Kowalski\nAnna Nowak\nPiotr Wisniewski'}
            />
            <p className="mt-2 text-xs text-muted">
              One per line, or comma separated. {recipients.length} recipient(s).
            </p>
            {duplicates ? (
              <p className="mt-1 text-xs text-danger">
                Repeated names would produce copies that cannot be told apart.
              </p>
            ) : null}
          </div>

          <div>
            <label htmlFor="template" className="text-sm font-medium">
              Payload written into each copy
            </label>
            <input
              id="template"
              value={template}
              onChange={(event) => setTemplate(event.target.value)}
              className="mt-2 w-full rounded-md border border-line bg-surface p-2 font-mono text-sm"
            />
            <p className="mt-2 text-xs text-muted">
              <code>{'{recipient}'}</code> and <code>{'{index}'}</code> are substituted. An
              opaque id keeps the recipient&apos;s name out of the document; a name makes the
              trace readable without a key. Keep your own list either way.
            </p>
          </div>

          <fieldset>
            <legend className="text-sm font-medium">Carrier</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {CHANNELS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setChannel(option)}
                  aria-pressed={channel === option}
                  className={`badge ${channel === option ? 'bg-accent/20 text-accent' : ''}`}
                >
                  {option.replace(/_/g, ' ')}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">{MARK_CHANNEL_NOTE[channel]}</p>
          </fieldset>

          <div>
            <label htmlFor="repeat" className="text-sm font-medium">
              Copies of the mark per document: {repeat}
            </label>
            <input
              id="repeat"
              type="range"
              min={1}
              max={10}
              value={repeat}
              onChange={(event) => setRepeat(Number(event.target.value))}
              className="mt-2 w-full"
            />
            <p className="text-xs text-muted">
              Spread across the document, so a quoted excerpt still carries the mark. More
              copies survive heavier editing and add more invisible characters.
            </p>
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn-primary" disabled={!ready || busy}>
            {busy ? 'Marking…' : 'Create marked copies'}
          </button>
          {result ? (
            <button type="button" className="btn-secondary" onClick={downloadAll}>
              Download all {result.copies.length}
            </button>
          ) : null}
        </div>
      </form>

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {result ? (
        <section className="card" aria-labelledby="copies-heading">
          <h2 id="copies-heading" className="text-base font-semibold">
            {result.copies.length} marked copies
          </h2>

          {result.warnings.map((warning) => (
            <p
              key={warning}
              className="mt-3 rounded-md border border-warn/30 bg-warn/10 p-3 text-sm text-warn"
            >
              {warning}
            </p>
          ))}

          <table className="mt-4 w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-2">Recipient</th>
                <th>Payload</th>
                <th>Added</th>
                <th>Read back</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {result.copies.map((copy) => (
                <tr key={copy.recipient} className="border-t border-line">
                  <td className="py-2">{copy.recipient}</td>
                  <td className="font-mono text-xs">{copy.payload}</td>
                  <td className="text-muted">{copy.carrier_chars} chars</td>
                  <td>{copy.verified ? '✓' : '—'}</td>
                  <td className="text-right">
                    <button
                      type="button"
                      className="text-accent hover:underline"
                      onClick={() => navigator.clipboard.writeText(copy.text)}
                    >
                      Copy
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
