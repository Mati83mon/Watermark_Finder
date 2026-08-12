/**
 * End-to-end smoke test against a *real* analysis engine.
 *
 * Not part of `npm test`: it needs the Python service running. Start it with
 *
 *   cd analysis-space && TPL_API_TOKEN=e2e-secret uvicorn app:app --port 7860
 *
 * then run
 *
 *   cd worker && npx tsx test/e2e.manual.ts
 *
 * It drives the actual Worker application (real routing, real D1 SQL against
 * in-memory SQLite, real R2/KV doubles) against the real engine, so the whole
 * contract between the two services is exercised, including the covert-channel
 * detection that the unit tests can only stub.
 */

import { createApp } from '../src/app';
import { Database } from '../src/lib/db';
import { createTestEnv, TestExecutionContext } from './harness/bindings';

const ENGINE_URL = process.env.ENGINE_URL ?? 'http://127.0.0.1:7860';
const ENGINE_TOKEN = process.env.ENGINE_TOKEN ?? 'e2e-secret';

/** Encode a payload into Unicode tag characters (invisible in every renderer). */
function encodeTagCharacters(payload: string): string {
  return [...payload]
    .map((character) => String.fromCodePoint(0xe0000 + character.codePointAt(0)!))
    .join('');
}

const ASSISTANT_TEXT = `Maintaining a bicycle is a crucial aspect of ensuring both safety
and longevity. Regular maintenance not only extends the lifespan of the components but also
significantly improves the overall riding experience. Moreover, a well-maintained bicycle is
considerably safer to operate in urban environments.

It is important to note that the drivetrain requires particular attention. Furthermore, the
derailleur should be inspected regularly to ensure optimal shifting performance. Additionally,
cables and housing should be replaced periodically, as degradation can significantly impact
performance.

In conclusion, a comprehensive maintenance routine is essential for any cyclist seeking to
leverage the full potential of their equipment.`;

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const app = createApp();
  const env = createTestEnv({
    ANALYSIS_SPACE_URL: ENGINE_URL,
    ANALYSIS_SPACE_TOKEN: ENGINE_TOKEN,
  });
  const ctx = new TestExecutionContext();

  const call = async (path: string, init: RequestInit & { token?: string } = {}) => {
    const { token, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    return app.fetch(
      new Request(`https://api.local${path}`, { ...rest, headers }),
      env,
      ctx as unknown as ExecutionContext,
    );
  };

  console.log(`\nEngine: ${ENGINE_URL}\n`);

  console.log('health');
  const health = await call('/api/health');
  const healthBody = (await health.json()) as { status: string; checks: Record<string, unknown> };
  check('worker reports healthy', health.status === 200, JSON.stringify(healthBody));
  check('engine reachable', healthBody.checks.engine === 'ok');

  console.log('session');
  const session = await call('/api/session', { method: 'POST' });
  const { token } = (await session.json()) as { token: string };
  check('workspace token issued', Boolean(token));

  console.log('analysis of watermarked text');
  const watermarked = `${ASSISTANT_TEXT}${encodeTagCharacters('wm:e2e-2026')}`;
  const created = await call('/api/analyses', {
    method: 'POST',
    token,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: watermarked, mode: 'forensic' }),
  });
  check('accepted with 202', created.status === 202);
  const { id } = (await created.json()) as { id: string };
  await ctx.settle();

  const detail = await call(`/api/analyses/${id}`, { token });
  const body = (await detail.json()) as {
    status: string;
    error: string | null;
    risk_score: number;
    watermark_label: string;
    result: {
      payloads: { text: string }[];
      segments: unknown[];
      findings: { severity: string }[];
      technical_report_markdown: string;
      scores: { llm_likelihood: { value: number; label: string } };
    } | null;
  };

  check('analysis completed', body.status === 'done', body.error ?? '');
  check('payload recovered', body.result?.payloads[0]?.text === 'wm:e2e-2026',
    JSON.stringify(body.result?.payloads));
  check('watermark verdict is payload_recovered', body.watermark_label === 'payload_recovered');
  check('risk is critical', body.risk_score >= 0.9, String(body.risk_score));
  check('a critical finding was raised',
    (body.result?.findings ?? []).some((finding) => finding.severity === 'critical'));
  check('report mentions the payload',
    (body.result?.technical_report_markdown ?? '').includes('wm:e2e-2026'));
  check('assistant register detected',
    (body.result?.scores.llm_likelihood.value ?? 0) > 0.55,
    String(body.result?.scores.llm_likelihood.value));

  const segments = await call(`/api/analyses/${id}/segments`, { token });
  const segmentBody = (await segments.json()) as { items: { start: number; end: number }[] };
  check('segments persisted to D1', segmentBody.items.length > 0);
  check('segment offsets are within the document',
    segmentBody.items.every((segment) => segment.end <= watermarked.length));

  const stored = await call(`/api/analyses/${id}/text`, { token });
  const storedBody = (await stored.json()) as { text: string };
  check('stored text is byte-identical to the submission', storedBody.text === watermarked);

  console.log('analysis of clean text');
  const cleanCreated = await call('/api/analyses', {
    method: 'POST',
    token,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: `I fixed the bike yesterday. Took three evenings, mostly because I kept
losing the little spring. It shifts fine now — not perfect, but fine. My neighbour says the
frame was his brother's in 1994. I don't believe him!`,
      mode: 'quick',
    }),
  });
  const cleanId = ((await cleanCreated.json()) as { id: string }).id;
  await ctx.settle();

  const cleanDetail = await call(`/api/analyses/${cleanId}`, { token });
  const cleanBody = (await cleanDetail.json()) as {
    status: string;
    watermark_label: string;
    risk_score: number;
  };
  check('clean analysis completed', cleanBody.status === 'done');
  check('no watermark claimed on clean text',
    ['clean', 'weak_indicators'].includes(cleanBody.watermark_label),
    cleanBody.watermark_label);
  check('clean text scores low risk', cleanBody.risk_score < 0.4, String(cleanBody.risk_score));

  console.log('file upload path');
  const form = new FormData();
  form.append('file', new File([watermarked], 'memo.txt', { type: 'text/plain' }), 'memo.txt');
  const upload = await call('/api/uploads', { method: 'POST', token, body: form });
  const { upload_id: uploadId } = (await upload.json()) as { upload_id: string };
  const fromFile = await call('/api/analyses', {
    method: 'POST',
    token,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ upload_id: uploadId, mode: 'quick' }),
  });
  const fileId = ((await fromFile.json()) as { id: string }).id;
  await ctx.settle();
  const fileDetail = (await (await call(`/api/analyses/${fileId}`, { token })).json()) as {
    status: string;
    source: string;
    result: { payloads: { text: string }[] } | null;
  };
  check('uploaded document analysed', fileDetail.status === 'done');
  check('source recorded as file', fileDetail.source === 'file');
  check('payload survives extraction',
    fileDetail.result?.payloads[0]?.text === 'wm:e2e-2026');

  console.log('stats');
  const stats = (await (await call('/api/stats', { token })).json()) as {
    total: number;
    payloads_recovered: number;
  };
  check('stats count every analysis', stats.total === 3, String(stats.total));
  check('stats count recovered payloads', stats.payloads_recovered === 2,
    String(stats.payloads_recovered));

  const events = await new Database(env.DB)
    .stats('unused')
    .then(() => true)
    .catch(() => false);
  check('database still queryable at the end', events);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\ne2e run failed:', error);
  process.exit(1);
});
