import { describe, expect, it } from 'vitest';
import type { Segment } from '@wf/shared';
import { averageScore, buildFragments, carrierOffsets } from '@/lib/heatmap';

function segment(index: number, start: number, end: number, score: number): Segment {
  return {
    index,
    start,
    end,
    word_count: Math.max(1, Math.round((end - start) / 5)),
    preview: '',
    llm_likelihood: score,
    label: 'mixed',
    watermark_hits: 0,
  };
}

const TEXT = 'abcdefghijklmnopqrstuvwxyz';

describe('buildFragments', () => {
  it('reproduces the source text exactly', () => {
    const fragments = buildFragments(TEXT, [
      segment(0, 0, 12, 0.8),
      segment(1, 8, 20, 0.2),
      segment(2, 16, 26, 0.6),
    ]);
    expect(fragments.map((fragment) => fragment.text).join('')).toBe(TEXT);
  });

  it('produces non-overlapping fragments in order', () => {
    const fragments = buildFragments(TEXT, [segment(0, 0, 15, 0.9), segment(1, 10, 26, 0.1)]);
    for (let i = 0; i < fragments.length - 1; i += 1) {
      expect(fragments[i]!.end).toBe(fragments[i + 1]!.start);
      expect(fragments[i]!.end).toBeGreaterThan(fragments[i]!.start);
    }
  });

  it('averages the score where segments overlap', () => {
    const fragments = buildFragments(TEXT, [segment(0, 0, 15, 1.0), segment(1, 10, 26, 0.0)]);
    const overlap = fragments.find(
      (fragment) => fragment.start === 10 && fragment.end === 15,
    );
    expect(overlap?.score).toBeCloseTo(0.5);
    expect(overlap?.segmentIndexes).toEqual([0, 1]);
  });

  it('marks uncovered regions with a null score', () => {
    const fragments = buildFragments(TEXT, [segment(0, 5, 10, 0.9)]);
    expect(fragments[0]?.score).toBeNull();
    expect(fragments[1]?.score).toBeCloseTo(0.9);
    expect(fragments[2]?.score).toBeNull();
  });

  it('returns one unscored fragment when there are no segments', () => {
    const fragments = buildFragments(TEXT, []);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toMatchObject({ start: 0, end: TEXT.length, score: null });
  });

  it('handles empty text', () => {
    expect(buildFragments('', [segment(0, 0, 10, 0.5)])).toEqual([]);
  });

  it('clamps segment bounds that exceed the text', () => {
    const fragments = buildFragments('short', [segment(0, 0, 999, 0.7)]);
    expect(fragments.map((fragment) => fragment.text).join('')).toBe('short');
    expect(fragments.every((fragment) => fragment.end <= 5)).toBe(true);
  });
});

describe('carrierOffsets', () => {
  it('collects offsets and caps very long spans', () => {
    const offsets = carrierOffsets([
      { offset: 5, length: 1 },
      { offset: 10, length: 3 },
      { offset: 100, length: 5000 },
      { offset: null, length: 4 },
    ]);
    expect(offsets.has(5)).toBe(true);
    expect(offsets.has(12)).toBe(true);
    expect(offsets.has(107)).toBe(true);
    expect(offsets.has(108)).toBe(false); // capped at 8
    expect(offsets.size).toBe(1 + 3 + 8);
  });
});

describe('averageScore', () => {
  it('weights by word count', () => {
    const value = averageScore([segment(0, 0, 100, 1.0), segment(1, 100, 110, 0.0)]);
    expect(value).toBeGreaterThan(0.8);
  });

  it('returns null with no segments', () => {
    expect(averageScore([])).toBeNull();
  });
});
