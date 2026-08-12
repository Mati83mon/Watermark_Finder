# Watermark Finder

Text provenance and watermark analysis. Finds hidden marks in documents —
zero-width characters, Unicode tag payloads, homoglyph substitution — and scores
how much the writing reads like unedited assistant output.

Runs entirely on free infrastructure: **Cloudflare Pages + Workers + D1/KV/R2**
for the application, a **Hugging Face Space** for the analysis engine. No paid
APIs, no cloud provider account, no LLM API calls at runtime. Every model the
engine uses is local, and most of the detection is deterministic Unicode work.

```
Pages (Next.js)  →  Worker (Hono + D1/KV/R2)  →  Space (FastAPI + Python)
   frontend            API, jobs, storage           all analysis
```

**Live:** [https://watermark-finder.pages.dev](https://watermark-finder.pages.dev) · API [health](https://watermark-finder-api.pennypicher-api.workers.dev/api/health) · engine on a Hugging Face Space

One caveat on "free": Hugging Face now requires a PRO subscription to host a
Docker Space on free `cpu-basic`, so the analysis engine is the one component
that is no longer free to host as designed. Everything on Cloudflare stays
within free allowances. See [`docs/deployment.md`](docs/deployment.md).

---

## What it does

**Finds hidden marks — deterministically.**

- Zero-width characters, Unicode tag characters, variation selectors, bidi
  controls, exotic whitespace, with exact offsets and codepoint names.
- **Decodes payloads.** Tag-character, variation-selector and zero-width-binary
  encodings are decoded and the recovered message is shown.
- Homoglyph substitution: Cyrillic `а` standing in for Latin `a` inside an
  otherwise-Latin word.

These are facts about the bytes of the document, not inferences.

**Scores writing register — probabilistically, with its uncertainty visible.**

- Twenty stylometric features (sentence-length burstiness, lexical diversity,
  connective density, register vocabulary, error profile), English and Polish.
- Every score comes with a plausible range, a confidence level, and the
  per-feature contributions that produced it.
- Short text is shrunk toward 50 % and labelled `insufficient_evidence` below 15
  words, because no stylometric method can read authorship off a paragraph.

**And shows its work.** A heatmap over the document, per-segment scores, a full
technical report in Markdown, and a findings list with recommended actions.

### What it does not do

It cannot tell you who wrote something. The style score measures *register*, not
authorship; it is unreliable on short, translated and lightly-edited text, and it
must not be the sole basis for an accusation, a grade or a disciplinary decision.
A clean result proves nothing either — normalising a document strips every covert
channel the tool can see. [`docs/detection-methods.md`](docs/detection-methods.md)
sets out the failure modes in detail; the application repeats them where the
numbers are shown.

---

## Repository layout

| Path | What it is |
| --- | --- |
| `analysis-space/` | FastAPI analysis engine — Unicode scanning, decoders, stylometry, report builder. Deploys to a Hugging Face Space. |
| `worker/` | Cloudflare Worker API — routing, validation, auth, rate limiting, job orchestration, D1/KV/R2 access. |
| `web/` | Next.js 14 frontend, static export, deploys to Cloudflare Pages. |
| `shared/` | TypeScript types shared by the Worker and the web app. |
| `docs/` | Architecture, API spec, database schema, deployment, detection methods. |
| `infra/` | Configuration templates and environment examples. |

---

## Quick start

```bash
git clone https://github.com/Mati83mon/Watermark_Finder.git
cd Watermark_Finder
npm install

# Engine
cd analysis-space
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app:app --reload --port 7860      # http://127.0.0.1:7860/docs

# Worker (new terminal)
cd worker
cp ../infra/dev.vars.example .dev.vars
npx wrangler d1 migrations apply watermark-finder --local
npx wrangler dev                          # http://127.0.0.1:8787

# Frontend (new terminal)
cd web && npm run dev                     # http://localhost:3000
```

Try it: paste a document into **New analysis**. To see the covert-channel
detection fire, plant a payload first:

```python
python -c "
from tpl.preprocessing import encode_tag_characters
print('An ordinary looking sentence.' + encode_tag_characters('wm:demo-1'))
" | pbcopy   # or xclip -selection clipboard
```

The pasted text looks unchanged. The analysis reports `payload_recovered` and
prints `wm:demo-1` back.

---

## Tests

```bash
npm test                                  # Worker (63) + web (41)
cd analysis-space && pytest               # engine (82)
```

End-to-end, driving the real Worker against the real Python engine:

```bash
cd analysis-space && TPL_API_TOKEN=e2e-secret uvicorn app:app --port 7860 &
cd worker && npx tsx test/e2e.manual.ts   # 24 checks
```

The Worker's D1 is a real in-memory SQLite database running the production
migration files, so the SQL is genuinely executed rather than mocked. CI runs all
four suites on every push.

---

## Deployment

Full walkthrough: [`docs/deployment.md`](docs/deployment.md). In short — deploy
the Space first, then the Worker (it needs the Space URL), then Pages (it needs
the Worker URL).

GitHub Actions handles all three once these are set:

| Kind | Name | For |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Worker + Pages |
| Secret | `HF_TOKEN` | Space |
| Variable | `API_BASE_URL`, `PAGES_PROJECT` | Worker + Pages |
| Variable | `HF_SPACE_ID`, `SPACE_URL` | Space |

Two secrets are set on the services themselves: `ANALYSIS_SPACE_TOKEN` on the
Worker must equal `TPL_API_TOKEN` on the Space, and `SESSION_SECRET` on the
Worker signs workspace tokens.

---

## Free-tier notes

The design is shaped by the free limits rather than merely fitting inside them:

- **No analysis at the edge.** Workers allow 10 ms CPU per request; the engine
  has 2 vCPU with no per-request cap. The Worker orchestrates and waits, and
  waiting is I/O, not CPU.
- **No Queues on the free plan.** Jobs run through `ctx.waitUntil()` with a
  five-minute cron sweep that retries anything stalled, bounded by `MAX_ATTEMPTS`.
- **Identical text is not re-analysed.** Submissions are deduplicated by hash and
  mode within a workspace.
- **A sleeping Space is a normal state.** Free Spaces idle out after ~48 h and
  take 30–60 s to wake. The client retries with backoff and the UI says what is
  happening rather than showing an error.
- **`DAILY_ANALYSIS_LIMIT`** caps what one workspace can spend of the shared
  budget.

---

## Privacy

There are no accounts. A workspace is an anonymous namespace identified by an
HMAC-signed token held in your browser — no email, no password, no personal data,
nothing to breach. Losing the token loses the history, which the Settings page
states plainly.

Submitted text is stored so results can be revisited and the heatmap rendered.
Deleting an analysis deletes its text, its result and its cache entry. The engine
itself stores nothing: it receives a string and returns JSON.

---

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | Component design, request flow, retry model, free-tier budget |
| [`docs/api-spec.md`](docs/api-spec.md) | Every endpoint, the full result schema, error codes |
| [`docs/database.md`](docs/database.md) | D1 tables, indexes, migration workflow |
| [`docs/deployment.md`](docs/deployment.md) | Step-by-step deployment and troubleshooting |
| [`docs/detection-methods.md`](docs/detection-methods.md) | How each detector works and where it fails |
| [`analysis-space/README.md`](analysis-space/README.md) | Engine internals, configuration, training |

## License

MIT — see [LICENSE](LICENSE).
