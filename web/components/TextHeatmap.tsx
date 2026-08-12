'use client';

import { useMemo, useState } from 'react';
import type { Segment, Signal } from '@wf/shared';
import { heatColor, percent, SEGMENT_LABEL_TEXT } from '@/lib/format';
import { buildFragments, carrierOffsets } from '@/lib/heatmap';

interface TextHeatmapProps {
  text: string;
  segments: Segment[];
  signals: Signal[];
}

/**
 * The document, tinted by per-segment style score, with hidden characters
 * marked inline.
 *
 * Every fragment is rendered exactly once and the concatenation of the
 * fragments equals the source text, so what the reader sees is the document -
 * not a reconstruction of it.
 */
export function TextHeatmap({ text, segments, signals }: TextHeatmapProps) {
  const [showCarriers, setShowCarriers] = useState(true);
  const [showHeat, setShowHeat] = useState(true);

  const fragments = useMemo(() => buildFragments(text, segments), [text, segments]);
  const carriers = useMemo(
    () => carrierOffsets(signals.flatMap((signal) => signal.evidence)),
    [signals],
  );

  return (
    <section className="card" aria-labelledby="heatmap-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="heatmap-heading" className="text-base font-semibold">
            Document view
          </h2>
          <p className="hint mt-1">
            Tint shows the per-segment style score; red leans assistant, green leans human.
          </p>
        </div>

        <div className="no-print flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showHeat}
              onChange={(event) => setShowHeat(event.target.checked)}
            />
            Style tint
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showCarriers}
              onChange={(event) => setShowCarriers(event.target.checked)}
            />
            Mark hidden characters ({carriers.size})
          </label>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-3 w-6 rounded"
            style={{ background: heatColor(0.05) }}
          />
          human
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-6 rounded border border-border" />
          mixed
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-3 w-6 rounded"
            style={{ background: heatColor(0.95) }}
          />
          assistant
        </span>
      </div>

      <div className="scroll-x mt-4 max-h-[32rem] overflow-y-auto rounded-md border border-border bg-surface p-4">
        <p className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed">
          {fragments.map((fragment) => (
            <FragmentSpan
              key={`${fragment.start}-${fragment.end}`}
              start={fragment.start}
              text={fragment.text}
              score={fragment.score}
              showHeat={showHeat}
              showCarriers={showCarriers}
              carriers={carriers}
            />
          ))}
        </p>
      </div>

      {segments.length > 0 ? (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium">
            Segment scores ({segments.length})
          </summary>
          <div className="scroll-x mt-3">
            <table className="w-full min-w-[36rem] border-collapse text-left">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="table-cell">#</th>
                  <th className="table-cell">Range</th>
                  <th className="table-cell">Words</th>
                  <th className="table-cell">Style</th>
                  <th className="table-cell">Reading</th>
                  <th className="table-cell">Hidden chars</th>
                </tr>
              </thead>
              <tbody>
                {segments.map((segment) => (
                  <tr key={segment.index} className="border-b border-border/60">
                    <td className="table-cell tabular-nums">{segment.index}</td>
                    <td className="table-cell tabular-nums text-muted">
                      {segment.start}–{segment.end}
                    </td>
                    <td className="table-cell tabular-nums">{segment.word_count}</td>
                    <td className="table-cell tabular-nums">
                      {percent(segment.llm_likelihood)}
                    </td>
                    <td className="table-cell">{SEGMENT_LABEL_TEXT[segment.label]}</td>
                    <td className="table-cell tabular-nums">
                      {segment.watermark_hits > 0 ? segment.watermark_hits : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </section>
  );
}

interface FragmentSpanProps {
  start: number;
  text: string;
  score: number | null;
  showHeat: boolean;
  showCarriers: boolean;
  carriers: Set<number>;
}

function FragmentSpan({
  start,
  text,
  score,
  showHeat,
  showCarriers,
  carriers,
}: FragmentSpanProps) {
  const background = showHeat && score !== null ? heatColor(score) : undefined;
  const title = score === null ? undefined : `Style score ${percent(score)}`;

  // Only split into per-character spans when this fragment actually contains a
  // carrier; splitting a whole document character by character would be slow.
  const hasCarrier =
    showCarriers &&
    carriers.size > 0 &&
    Array.from({ length: text.length }, (_, index) => start + index).some((offset) =>
      carriers.has(offset),
    );

  if (!hasCarrier) {
    return (
      <span style={background ? { background } : undefined} title={title}>
        {text}
      </span>
    );
  }

  return (
    <span style={background ? { background } : undefined} title={title}>
      {Array.from(text).map((character, index) => {
        const offset = start + index;
        if (!carriers.has(offset)) {
          return <span key={offset}>{character}</span>;
        }
        return (
          <mark
            key={offset}
            className="rounded-sm bg-danger/30 px-0.5 text-danger"
            title={`Hidden character at offset ${offset}: U+${character
              .codePointAt(0)!
              .toString(16)
              .toUpperCase()
              .padStart(4, '0')}`}
          >
            ␥
          </mark>
        );
      })}
    </span>
  );
}
