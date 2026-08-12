/**
 * Turn overlapping scored segments into non-overlapping fragments for rendering.
 *
 * The engine emits sliding windows that overlap by design, so a character can
 * belong to several segments. Rendering them naively would duplicate text. This
 * module cuts the document at every segment boundary and assigns each resulting
 * fragment the mean score of the segments covering it, which keeps the rendered
 * text exactly equal to the input.
 */

import type { Segment } from '@wf/shared';

export interface Fragment {
  start: number;
  end: number;
  text: string;
  /** Mean segment score over this fragment, or null where no segment covers it. */
  score: number | null;
  segmentIndexes: number[];
}

export function buildFragments(text: string, segments: Segment[]): Fragment[] {
  if (text.length === 0) return [];
  if (segments.length === 0) {
    return [{ start: 0, end: text.length, text, score: null, segmentIndexes: [] }];
  }

  const boundaries = new Set<number>([0, text.length]);
  for (const segment of segments) {
    boundaries.add(Math.max(0, Math.min(segment.start, text.length)));
    boundaries.add(Math.max(0, Math.min(segment.end, text.length)));
  }

  const cuts = [...boundaries].sort((a, b) => a - b);
  const fragments: Fragment[] = [];

  for (let i = 0; i < cuts.length - 1; i += 1) {
    const start = cuts[i]!;
    const end = cuts[i + 1]!;
    if (end <= start) continue;

    const covering = segments.filter(
      (segment) => segment.start < end && segment.end > start,
    );
    const score =
      covering.length === 0
        ? null
        : covering.reduce((sum, segment) => sum + segment.llm_likelihood, 0) / covering.length;

    fragments.push({
      start,
      end,
      text: text.slice(start, end),
      score,
      segmentIndexes: covering.map((segment) => segment.index),
    });
  }

  return fragments;
}

/** Character offsets that should be marked as carrying a hidden character. */
export function carrierOffsets(
  evidence: { offset: number | null; length: number }[],
): Set<number> {
  const offsets = new Set<number>();
  for (const item of evidence) {
    if (item.offset === null) continue;
    // A long span marks only its start; highlighting thousands of characters
    // would swamp the reading view.
    const span = Math.min(item.length, 8);
    for (let i = 0; i < span; i += 1) offsets.add(item.offset + i);
  }
  return offsets;
}

/** Mean score across the document, used for the summary strip. */
export function averageScore(segments: Segment[]): number | null {
  if (segments.length === 0) return null;
  const weighted = segments.reduce(
    (accumulator, segment) => {
      const weight = Math.max(1, segment.word_count);
      return {
        sum: accumulator.sum + segment.llm_likelihood * weight,
        weight: accumulator.weight + weight,
      };
    },
    { sum: 0, weight: 0 },
  );
  return weighted.weight === 0 ? null : weighted.sum / weighted.weight;
}
