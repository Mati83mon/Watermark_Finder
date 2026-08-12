'use client';

import type { Confidence } from '@wf/shared';
import { percent } from '@/lib/format';

interface ScoreCardProps {
  title: string;
  value: number;
  label: string;
  confidence?: Confidence;
  /** Uncertainty band, drawn on the meter when present. */
  low?: number;
  high?: number;
  tone: 'ok' | 'warn' | 'danger' | 'neutral';
  footnote?: string;
}

const TONE_BAR: Record<ScoreCardProps['tone'], string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  neutral: 'bg-accent',
};

/**
 * A single headline score.
 *
 * When a band is supplied it is drawn as a lighter region around the point
 * estimate, so a wide interval reads as uncertainty instead of being hidden
 * behind a confident-looking number.
 */
export function ScoreCard({
  title,
  value,
  label,
  confidence,
  low,
  high,
  tone,
  footnote,
}: ScoreCardProps) {
  const hasBand = low !== undefined && high !== undefined && high > low;

  return (
    <div className="card">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-muted">{title}</h3>
        {confidence ? (
          <span className="hint">
            confidence: <strong className="font-medium">{confidence}</strong>
          </span>
        ) : null}
      </div>

      <p className="mt-2 text-3xl font-semibold tabular-nums">{percent(value)}</p>
      <p className="mt-0.5 text-sm">{label}</p>

      <div
        className="relative mt-4 h-2 w-full overflow-hidden rounded-full bg-border"
        role="meter"
        aria-valuenow={Math.round(value * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${title}: ${percent(value)}`}
      >
        {hasBand ? (
          <span
            className={`absolute inset-y-0 rounded-full ${TONE_BAR[tone]} opacity-30`}
            style={{ left: `${low * 100}%`, width: `${(high - low) * 100}%` }}
          />
        ) : null}
        <span
          className={`absolute inset-y-0 left-0 rounded-full ${TONE_BAR[tone]}`}
          style={{ width: `${Math.max(1.5, value * 100)}%`, opacity: hasBand ? 0.85 : 1 }}
        />
      </div>

      {hasBand ? (
        <p className="hint mt-2 tabular-nums">
          plausible range {percent(low)} – {percent(high)}
        </p>
      ) : null}
      {footnote ? <p className="hint mt-2">{footnote}</p> : null}
    </div>
  );
}
