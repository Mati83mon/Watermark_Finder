/** Presentation helpers shared across views. */

import type { RiskLabel, SegmentLabel, Severity } from '@wf/shared';

export function percent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatDate(epochMs: number | null | undefined): string {
  if (!epochMs) return '—';
  return new Date(epochMs).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function relativeTime(epochMs: number | null | undefined, now = Date.now()): string {
  if (!epochMs) return '—';
  const seconds = Math.round((epochMs - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
    ['year', Number.POSITIVE_INFINITY],
  ];

  let value = seconds;
  for (const [unit, size] of units) {
    if (Math.abs(value) < size) {
      return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
        Math.round(value),
        unit,
      );
    }
    value /= size;
  }
  return formatDate(epochMs);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Tailwind classes per risk band. Kept in one place so the palette stays consistent. */
export const RISK_CLASSES: Record<RiskLabel, string> = {
  minimal: 'bg-ok/10 text-ok border-ok/30',
  low: 'bg-ok/10 text-ok border-ok/30',
  medium: 'bg-warn/10 text-warn border-warn/30',
  high: 'bg-danger/10 text-danger border-danger/30',
  critical: 'bg-danger/15 text-danger border-danger/50',
};

export const SEVERITY_CLASSES: Record<Severity, string> = {
  info: 'bg-accent/10 text-accent border-accent/30',
  low: 'bg-ok/10 text-ok border-ok/30',
  medium: 'bg-warn/10 text-warn border-warn/30',
  high: 'bg-danger/10 text-danger border-danger/30',
  critical: 'bg-danger/15 text-danger border-danger/50',
};

export const SEGMENT_LABEL_TEXT: Record<SegmentLabel, string> = {
  human: 'Human',
  leaning_human: 'Leaning human',
  mixed: 'Mixed',
  leaning_assistant: 'Leaning assistant',
  assistant: 'Assistant',
};

/**
 * Background colour for a heatmap fragment.
 *
 * Deliberately a diverging scale from a neutral middle: the interesting signal
 * is distance from 0.5 in either direction, and a sequential ramp would imply
 * that "more colour" always means "more suspicious".
 */
export function heatColor(score: number): string {
  const distance = Math.abs(score - 0.5) * 2; // 0 at the midpoint, 1 at either end
  const alpha = 0.08 + distance * 0.32;
  return score >= 0.5
    ? `rgb(var(--danger) / ${alpha.toFixed(3)})`
    : `rgb(var(--ok) / ${alpha.toFixed(3)})`;
}

export function statusText(status: string): string {
  return (
    {
      pending: 'Queued',
      running: 'Analysing',
      done: 'Complete',
      error: 'Failed',
    }[status] ?? status
  );
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function countWords(text: string): number {
  const matches = text.match(/[^\s]+/g);
  return matches ? matches.length : 0;
}

/**
 * Rough token estimate for the composer's counter.
 *
 * ~4 characters per token is the usual English approximation. It is labelled as
 * an estimate in the UI because the real number depends on the tokenizer, and
 * nothing in this application actually tokenises.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
