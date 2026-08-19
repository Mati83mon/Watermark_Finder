import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Finding, SanitizeResult, Segment, Signal } from '@wf/shared';
import { api } from '@/lib/api';
import { SanitizePanel } from '@/components/SanitizePanel';
import { ScoreCard } from '@/components/ScoreCard';
import { FindingList, SignalList } from '@/components/SignalList';
import { TextHeatmap } from '@/components/TextHeatmap';
import { estimateTokens, countWords, heatColor, percent, truncate } from '@/lib/format';

describe('ScoreCard', () => {
  it('shows the score, label and an accessible meter', () => {
    render(
      <ScoreCard
        title="Watermark"
        value={0.87}
        label="Watermark detected"
        confidence="high"
        tone="danger"
      />,
    );
    expect(screen.getByText('87%')).toBeInTheDocument();
    expect(screen.getByText('Watermark detected')).toBeInTheDocument();
    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('aria-valuenow', '87');
  });

  it('renders the uncertainty band when supplied', () => {
    render(
      <ScoreCard title="Style" value={0.6} low={0.4} high={0.8} label="Inconclusive" tone="warn" />,
    );
    expect(screen.getByText(/plausible range/i)).toHaveTextContent('40% – 80%');
  });

  it('omits the band when it is not supplied', () => {
    render(<ScoreCard title="Style" value={0.6} label="Inconclusive" tone="warn" />);
    expect(screen.queryByText(/plausible range/i)).not.toBeInTheDocument();
  });
});

describe('FindingList', () => {
  const finding: Finding = {
    id: 'f1',
    severity: 'critical',
    title: 'Hidden message recovered',
    detail: 'Decoded content: wm:demo',
    recommendation: 'Strip the carrier characters.',
  };

  it('renders findings with severity and recommendation', () => {
    render(<FindingList findings={[finding]} />);
    expect(screen.getByText('Hidden message recovered')).toBeInTheDocument();
    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.getByText(/Strip the carrier characters/)).toBeInTheDocument();
  });

  it('says so plainly when nothing was flagged', () => {
    render(<FindingList findings={[]} />);
    expect(screen.getByText(/Nothing was flagged/i)).toBeInTheDocument();
  });
});

describe('SignalList', () => {
  const signal: Signal = {
    id: 'invisible_characters',
    category: 'covert_channel',
    title: 'Invisible characters embedded in the text',
    description: '12 characters that render as nothing were found.',
    score: 0.82,
    weight: 1,
    severity: 'high',
    evidence: [{ kind: 'char', detail: 'U+200B ZERO WIDTH SPACE', offset: 42, length: 1 }],
    evidence_total: 12,
  };

  it('renders the signal with its evidence and truncation note', () => {
    render(<SignalList signals={[signal]} />);
    expect(screen.getByText(signal.title)).toBeInTheDocument();
    expect(screen.getByText('82%')).toBeInTheDocument();
    expect(screen.getByText(/U\+200B/)).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 12/)).toBeInTheDocument();
  });

  it('does not claim a clean document is proof of anything', () => {
    render(<SignalList signals={[]} />);
    expect(screen.getByText(/not proof that none was ever there/i)).toBeInTheDocument();
  });
});

describe('TextHeatmap', () => {
  const segments: Segment[] = [
    {
      index: 0,
      start: 0,
      end: 11,
      word_count: 2,
      preview: 'Hello world',
      llm_likelihood: 0.9,
      label: 'assistant',
      watermark_hits: 1,
    },
    {
      index: 1,
      start: 11,
      end: 22,
      word_count: 2,
      preview: ' and beyond',
      llm_likelihood: 0.1,
      label: 'human',
      watermark_hits: 0,
    },
  ];

  it('renders the document text exactly once', () => {
    const text = 'Hello world and beyond';
    const { container } = render(
      <TextHeatmap text={text} segments={segments} signals={[]} />,
    );
    const paragraph = container.querySelector('p.whitespace-pre-wrap');
    expect(paragraph?.textContent).toBe(text);
  });

  it('lists every segment with its score', () => {
    render(<TextHeatmap text="Hello world and beyond" segments={segments} signals={[]} />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('90%')).toBeInTheDocument();
    expect(within(table).getByText('10%')).toBeInTheDocument();
  });

  it('offers a toggle for hidden characters and counts them', () => {
    const signals: Signal[] = [
      {
        id: 'invisible_characters',
        category: 'covert_channel',
        title: 'Invisible characters',
        description: '',
        score: 0.8,
        weight: 1,
        severity: 'high',
        evidence: [{ kind: 'char', detail: 'ZWSP', offset: 5, length: 1 }],
        evidence_total: 1,
      },
    ];
    render(<TextHeatmap text="Hello world" segments={segments} signals={signals} />);
    expect(screen.getByLabelText(/Mark hidden characters \(1\)/)).toBeInTheDocument();
  });
});

describe('formatting helpers', () => {
  it('formats percentages and handles missing values', () => {
    expect(percent(0.4567)).toBe('46%');
    expect(percent(0.4567, 1)).toBe('45.7%');
    expect(percent(null)).toBe('—');
    expect(percent(undefined)).toBe('—');
  });

  it('produces a diverging heat colour around the midpoint', () => {
    expect(heatColor(0.95)).toContain('--danger');
    expect(heatColor(0.05)).toContain('--ok');
    // The midpoint is nearly transparent in either direction.
    expect(heatColor(0.5)).toContain('0.080');
  });

  it('counts words and estimates tokens', () => {
    expect(countWords('one two  three\nfour')).toBe(4);
    expect(countWords('   ')).toBe(0);
    expect(estimateTokens('12345678')).toBe(2);
  });

  it('truncates with an ellipsis only when needed', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('a much longer string', 8)).toBe('a much …');
  });
});

describe('SanitizePanel', () => {
  const clean: SanitizeResult = {
    text: 'Confidential draft.',
    level: 'safe',
    changed: true,
    removed: [],
    removed_total: 5,
    replaced: [],
    replaced_total: 0,
    preserved: [
      {
        offset: 4,
        codepoint: 'U+200C',
        name: 'ZERO WIDTH NON-JOINER',
        reason: 'joins an emoji sequence or a script that spells words with it',
      },
    ],
    preserved_total: 1,
    warnings: ['1 invisible character(s) were kept because this document needs them.'],
  };

  it('explains what each level does before the user picks one', () => {
    render(<SanitizePanel text="hello" filename="draft.txt" />);
    expect(screen.getByText(/Keeps invisible characters this document genuinely needs/)).toBeInTheDocument();
  });

  it('says plainly that nothing is stored', () => {
    render(<SanitizePanel text="hello" filename={null} />);
    expect(screen.getByText(/never written to\s+the database/)).toBeInTheDocument();
  });

  it('reports removals, replacements and what it deliberately kept', async () => {
    vi.spyOn(api, 'sanitize').mockResolvedValue(clean);
    render(<SanitizePanel text="hello" filename="draft.txt" />);

    fireEvent.click(screen.getByRole('button', { name: 'Clean document' }));

    expect(await screen.findByText('5')).toBeInTheDocument();
    expect(screen.getByText(/Kept on purpose/)).toBeInTheDocument();
    // The gap the safe level leaves is surfaced, not hidden.
    expect(
      screen.getByText(/kept because this document needs them/),
    ).toBeInTheDocument();
    expect(screen.getByText(/What was kept, and why/)).toBeInTheDocument();
  });

  it('offers the cleaned text only once there is a result', async () => {
    vi.spyOn(api, 'sanitize').mockResolvedValue(clean);
    render(<SanitizePanel text="hello" filename="draft.txt" />);

    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clean document' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument(),
    );
  });
});
