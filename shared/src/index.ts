/**
 * Types shared by the Cloudflare Worker and the Next.js frontend.
 *
 * These mirror the JSON contract produced by the analysis engine
 * (`analysis-space/tpl/pipeline.py`). The engine stamps every payload with
 * `schema_version`; when that changes, this file changes with it.
 */

export const SCHEMA_VERSION = '1.0';

export type AnalysisMode = 'quick' | 'forensic';

export type AnalysisStatus = 'pending' | 'running' | 'done' | 'error';

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/**
 * `structural` is byte evidence like the other two hard categories, not a style
 * hint: a phrase stamped back to back through a document, which is how a visual
 * watermark looks once a PDF has been through text extraction.
 */
export type SignalCategory =
  | 'covert_channel'
  | 'obfuscation'
  | 'structural'
  | 'stylistic';

export type WatermarkBasis = 'bytes' | 'stylistic' | 'none';

export type WatermarkLabel =
  | 'payload_recovered'
  | 'watermark_detected'
  | 'watermark_suspected'
  | 'weak_indicators'
  | 'clean';

export type StyleLabel =
  | 'insufficient_evidence'
  | 'likely_human'
  | 'inconclusive'
  | 'likely_ai'
  | 'very_likely_ai';

export type SegmentLabel =
  | 'human'
  | 'leaning_human'
  | 'mixed'
  | 'leaning_assistant'
  | 'assistant';

export type RiskLabel = 'minimal' | 'low' | 'medium' | 'high' | 'critical';

export type Confidence = 'none' | 'low' | 'medium' | 'high';

export interface Evidence {
  kind: string;
  detail: string;
  offset: number | null;
  length: number;
}

export interface Signal {
  id: string;
  category: SignalCategory;
  title: string;
  description: string;
  score: number;
  weight: number;
  severity: Severity;
  evidence: Evidence[];
  evidence_total: number;
}

export interface Contribution {
  feature: string;
  value: number;
  z: number;
  contribution: number;
  direction: 'assistant' | 'human';
  rationale: string;
}

export interface StyleScore {
  value: number;
  low: number;
  high: number;
  label: StyleLabel;
  confidence: Confidence;
  model_id: string;
  trained: boolean;
  contributions: Contribution[];
  notes: string[];
}

export interface Segment {
  index: number;
  start: number;
  end: number;
  word_count: number;
  preview: string;
  llm_likelihood: number;
  label: SegmentLabel;
  watermark_hits: number;
}

export interface DecodedPayload {
  channel: string;
  text: string;
  byte_length: number;
  printable_ratio: number;
  carrier_count: number;
  first_offset: number;
  last_offset: number;
  note: string;
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  recommendation: string;
}

export interface StyleProfileMatch {
  family: string;
  label: string;
  similarity: number;
  rationale: string;
  speculative: boolean;
}

export interface PerplexityInfo {
  available: boolean;
  model?: string;
  reason?: string;
  mean_surprisal?: number;
  surprisal_cv?: number;
  perplexity?: number;
  token_count?: number;
  signal?: number;
}

/** The full payload returned by the engine's `POST /analyze`. */
export interface AnalysisResult {
  schema_version: string;
  engine: {
    name: string;
    version: string;
    mode: AnalysisMode;
    style_model: string;
    style_model_trained: boolean;
  };
  input: {
    chars: number;
    words: number;
    sentences: number;
    paragraphs: number;
    language: string;
    scripts: Record<string, number>;
    sha256: string;
  };
  scores: {
    llm_likelihood: StyleScore;
    watermark: {
      value: number;
      label: WatermarkLabel;
      confidence: Confidence;
      /**
       * Where the number came from. `bytes` means a covert-channel,
       * obfuscation or structural signal fired and the score rests on what is
       * actually in the document - characters that do not render, or a phrase
       * stamped across it. `stylistic` means nothing was found in the bytes and
       * the score is a capped stylistic hint. `none` means no signal fired.
       * Callers must not describe a `stylistic` score as deterministic.
       */
      basis: WatermarkBasis;
    };
    risk: { value: number; label: RiskLabel };
  };
  signals: Signal[];
  payloads: DecodedPayload[];
  segments: Segment[];
  style_profiles: { disclaimer: string; matches: StyleProfileMatch[] };
  features: { values: Record<string, number>; docs: Record<string, string> };
  perplexity: PerplexityInfo;
  findings: Finding[];
  technical_report_markdown: string;
  warnings: string[];
  timings_ms: Record<string, number>;
  model_metrics: Record<string, unknown>;
}

/** Row-level summary the Worker keeps in D1 for list views. */
export interface AnalysisSummary {
  id: string;
  status: AnalysisStatus;
  mode: AnalysisMode;
  source: 'text' | 'file';
  filename: string | null;
  char_count: number;
  word_count: number | null;
  language: string | null;
  risk_score: number | null;
  risk_label: RiskLabel | null;
  watermark_score: number | null;
  watermark_label: WatermarkLabel | null;
  llm_score: number | null;
  llm_label: StyleLabel | null;
  error: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface AnalysisDetail extends AnalysisSummary {
  text_sha256: string;
  attempts: number;
  engine_version: string | null;
  result: AnalysisResult | null;
}

export interface Report {
  id: string;
  analysis_id: string;
  title: string;
  notes: string | null;
  created_at: number;
}

export interface Session {
  workspace_id: string;
  token: string;
  created_at: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Stats {
  total: number;
  by_status: Record<AnalysisStatus, number>;
  watermarks_detected: number;
  payloads_recovered: number;
  average_risk: number | null;
  last_7_days: { date: string; count: number }[];
}

export interface ApiError {
  error: string;
  message: string;
  request_id?: string;
  details?: unknown;
}

export interface Capabilities {
  modes: AnalysisMode[];
  max_chars: number;
  max_upload_bytes: number;
  supported_uploads: string[];
  perplexity_enabled: boolean;
  engine_version: string | null;
  engine_reachable: boolean;
}

/** Presentation helpers, kept next to the types they describe. */
export const RISK_ORDER: RiskLabel[] = ['minimal', 'low', 'medium', 'high', 'critical'];

export const SEVERITY_ORDER: Severity[] = ['info', 'low', 'medium', 'high', 'critical'];

export function riskLabelFor(score: number): RiskLabel {
  if (score >= 0.8) return 'critical';
  if (score >= 0.6) return 'high';
  if (score >= 0.35) return 'medium';
  if (score >= 0.15) return 'low';
  return 'minimal';
}

export const STYLE_LABEL_TEXT: Record<StyleLabel, string> = {
  insufficient_evidence: 'Not enough text',
  likely_human: 'Reads as human',
  inconclusive: 'Inconclusive',
  likely_ai: 'Reads as assistant output',
  very_likely_ai: 'Strongly assistant-like',
};

/**
 * Caption printed under the watermark score. It must track where the number
 * came from: describing a score as "deterministic" when it rests only on em
 * dash frequency tells the reader something was found in the bytes when
 * nothing was.
 */
export type SanitizeLevel = 'safe' | 'aggressive';

export interface SanitizeChange {
  offset: number;
  codepoint: string;
  name: string;
  reason: string;
}

export interface SanitizeReplacement {
  offset: number;
  before: string;
  after: string;
  reason: string;
}

/**
 * Result of stripping covert-channel characters from a document.
 *
 * `preserved` is not padding: a joiner that Arabic or an emoji sequence needs
 * is also somewhere a mark can hide, so the safe level keeps it and says so
 * rather than corrupting the text silently.
 */
export interface SanitizeResult {
  text: string;
  level: SanitizeLevel;
  changed: boolean;
  removed: SanitizeChange[];
  removed_total: number;
  replaced: SanitizeReplacement[];
  replaced_total: number;
  preserved: SanitizeChange[];
  preserved_total: number;
  warnings: string[];
}

export type MarkChannel = 'tag_characters' | 'variation_selectors' | 'zero_width_binary';

export interface MarkedCopy {
  recipient: string;
  payload: string;
  text: string;
  channel: MarkChannel;
  carrier_chars: number;
  copies_embedded: number;
  /** The engine decoded the mark back out before returning the copy. */
  verified: boolean;
}

export interface MarkResult {
  channel: MarkChannel;
  copies: MarkedCopy[];
  warnings: string[];
}

export const MARK_CHANNEL_NOTE: Record<MarkChannel, string> = {
  tag_characters:
    'One invisible codepoint per character. Printable ASCII payloads only. Survives copy-paste between most editors.',
  variation_selectors:
    'One codepoint per byte, so accented and non-Latin payloads fit.',
  zero_width_binary:
    'Eight codepoints per byte. Bulky, but built only from common zero-width characters that some pipelines pass through.',
};

/**
 * A C2PA content credential read out of a file.
 *
 * `integrity` and `trust` are deliberately separate. A signature that verifies
 * against a certificate nobody recognises is not verified provenance — anyone
 * can mint a certificate whose common name reads "Adobe Inc." — and an intact
 * file signed by an unknown party has still not been tampered with. Rendering
 * one without the other misleads in one direction or the other.
 */
export interface C2paResult {
  present: boolean;
  filename?: string | null;
  mime_type?: string;
  bytes?: number;
  /** intact | broken | unknown */
  integrity: 'intact' | 'broken' | 'unknown';
  /** recognised | unrecognised | unknown */
  trust: 'recognised' | 'unrecognised' | 'unknown';
  raw_state: string | null;
  generator: string | null;
  signer_common_name: string | null;
  signer_issuer: string | null;
  signature_alg: string | null;
  title: string | null;
  embedded: boolean | null;
  /** True when the credential itself declares generative-AI authorship. */
  ai_declared: boolean | null;
  actions: string[];
  failures: string[];
  notes: string[];
  reason: string | null;
}

export const WATERMARK_BASIS_NOTE: Record<WatermarkBasis, string> = {
  bytes: 'Deterministic: based on the actual bytes of the document.',
  stylistic:
    'No hidden characters found. This is a capped stylistic hint, not byte evidence.',
  none: 'Deterministic: no covert channel found in the bytes of the document.',
};

export const WATERMARK_LABEL_TEXT: Record<WatermarkLabel, string> = {
  payload_recovered: 'Hidden payload recovered',
  watermark_detected: 'Watermark detected',
  watermark_suspected: 'Watermark suspected',
  weak_indicators: 'Weak indicators',
  clean: 'No covert channel found',
};
