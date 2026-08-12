'use client';

import type { Finding, Signal } from '@wf/shared';
import { percent, SEVERITY_CLASSES } from '@/lib/format';

export function FindingList({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) {
    return (
      <div className="card">
        <h2 className="text-base font-semibold">Findings</h2>
        <p className="mt-2 text-sm text-muted">Nothing was flagged in this document.</p>
      </div>
    );
  }

  return (
    <section className="card" aria-labelledby="findings-heading">
      <h2 id="findings-heading" className="text-base font-semibold">
        Findings
      </h2>
      <ul className="mt-4 space-y-4">
        {findings.map((finding) => (
          <li key={finding.id} className="border-l-2 border-border pl-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`badge ${SEVERITY_CLASSES[finding.severity]}`}>
                {finding.severity}
              </span>
              <h3 className="text-sm font-semibold">{finding.title}</h3>
            </div>
            <p className="mt-1.5 text-sm">{finding.detail}</p>
            <p className="mt-1.5 text-sm text-muted">
              <span className="font-medium">Recommended action:</span> {finding.recommendation}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SignalList({ signals }: { signals: Signal[] }) {
  if (signals.length === 0) {
    return (
      <div className="card">
        <h2 className="text-base font-semibold">Signals</h2>
        <p className="mt-2 text-sm text-muted">
          No watermark or obfuscation signal fired. Note that normalising a document removes every
          covert channel this tool can see, so a clean result is not proof that none was ever there.
        </p>
      </div>
    );
  }

  return (
    <section className="card" aria-labelledby="signals-heading">
      <h2 id="signals-heading" className="text-base font-semibold">
        Signals ({signals.length})
      </h2>
      <ul className="mt-4 space-y-3">
        {signals.map((signal) => (
          <li key={signal.id} className="rounded-md border border-border">
            <details>
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 p-3">
                <span className={`badge ${SEVERITY_CLASSES[signal.severity]}`}>
                  {signal.severity}
                </span>
                <span className="text-sm font-medium">{signal.title}</span>
                <span className="ml-auto text-sm tabular-nums text-muted">
                  {percent(signal.score)}
                </span>
              </summary>

              <div className="border-t border-border p-3">
                <p className="text-sm">{signal.description}</p>
                <p className="hint mt-2">
                  category: {signal.category.replace(/_/g, ' ')} · weight {signal.weight}
                </p>

                {signal.evidence.length > 0 ? (
                  <ul className="mt-3 space-y-1.5">
                    {signal.evidence.map((evidence, index) => (
                      <li
                        key={`${signal.id}-${index}`}
                        className="break-words font-mono text-xs text-muted"
                      >
                        {evidence.offset !== null ? (
                          <span className="text-ink">@{evidence.offset} </span>
                        ) : null}
                        {evidence.detail}
                      </li>
                    ))}
                  </ul>
                ) : null}

                {signal.evidence_total > signal.evidence.length ? (
                  <p className="hint mt-2">
                    Showing {signal.evidence.length} of {signal.evidence_total} occurrences.
                  </p>
                ) : null}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
