# Watermark Finder

**→ [watermark-finder.pages.dev](https://watermark-finder.pages.dev) — a fully working web application. No signup, nothing to install.**

**→ [Browser build](https://huggingface.co/spaces/Mati83moni/watermark-finder) — the same engine under WebAssembly. The document never leaves your tab.**

[![CI](https://github.com/Mati83mon/Watermark_Finder/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Mati83mon/Watermark_Finder/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

🇵🇱 [Ten dokument po polsku](README.pl.md) · [Examples with real results](examples/README.md)

Mark a document invisibly, find the mark in a document you received, or strip
it out before passing the document on. Zero-width characters, Unicode tag
payloads, homoglyph substitution. It also scores how much the writing reads
like unedited assistant output — with loud caveats, because that part measures
register, not authorship.

```
MARK  ─────────────►  DETECT  ─────────────►  CLEAN
one traceable copy    hidden characters,      remove the carriers
per recipient         C2PA credentials        without breaking the text
```

```
Pages (Next.js)  →  Worker (Hono + D1/KV/R2)  →  Space (FastAPI + Python)
   frontend            API, jobs, storage           all analysis
```

---

## Try it in 30 seconds

Paste this into [the app](https://watermark-finder.pages.dev). It looks like an
ordinary sentence — it is not:

```python
message = "owner:Mateusz|id:WF-001"
hidden  = "".join(chr(0xE0000 + ord(c)) for c in message)
print("Analiza systemów autonomicznych wskazuje na kluczowe znaczenie." + hidden)
```

The app answers `payload_recovered`, **98%**, and prints
`owner:Mateusz|id:WF-001` back with the exact offsets of the carrier characters.

Prefer files? [`examples/`](examples/README.md) has six ready documents, one per
detector, with the results each should produce.

---

## What it does

### Finds hidden marks — deterministically

| Channel | What it is | Example result |
| --- | --- | --- |
| Unicode tag characters | `U+E0000 + n` maps to ASCII `n`, renders as nothing | `payload_recovered` 98%, message quoted back |
| Variation selectors | byte `b` → `U+FE00+b` / `U+E0100+b-16`, 256-value alphabet | `payload_recovered` 98% |
| Zero-width binary | `U+200B` = 0, `U+200C` = 1, six symbol pairings tried | `payload_recovered` 99% |
| Zero-width markers | a symbol at fixed intervals, no message | `watermark_detected` 92%, **no payload claimed** |
| Homoglyphs | Cyrillic `е` inside a Latin word | `watermark_suspected` 65% |
| Bidi controls, exotic spaces | reordering and spacing channels | reported with offsets |
| Repetition stamps | a phrase repeated back to back — a white-on-white or behind-the-page watermark, once the PDF has been text-extracted | `watermark_detected` 83% |

These are facts about the bytes of the document, not inferences. Every finding
comes with the exact character offset, the codepoint, its Unicode name and the
surrounding context.

### Scores writing register — probabilistically, with its uncertainty visible

Eighteen stylometric features — sentence-length burstiness, connective density,
register vocabulary, error profile — over English and Polish marker lists.

Every score carries a plausible range, a confidence level, and the per-feature
contributions that produced it:

```
STYLE  0.86  [0.51–1.00]  very_likely_ai  confidence: low

  assistant_lexicon_rate   z=+2.50  → assistant
  discourse_marker_rate    z=+2.50  → assistant
  sentence_length_cv       z=-1.83  → assistant
```

Below 150 words the score is pulled toward 50%; below 15 words it refuses a
verdict entirely and returns `insufficient_evidence`.

### Marks documents so a leak can be traced

Paste a confidential draft, list who receives it, and get one copy per person.
The copies read identically; each carries a different invisible id.

```
Jan Kowalski     WF-001    +14 chars   read back ✓
Anna Nowak       WF-002    +14 chars   read back ✓
Piotr Wisniewski WF-003    +14 chars   read back ✓
```

Every copy is verified by decoding the mark back out before it is handed to
you. Marks are spread across sentence boundaries, so a quoted excerpt still
carries one — a 50% excerpt recovers the whole payload in the test suite.

The mark is not secret: anyone with this tool reads it, and this tool's own
cleaner removes it. It traces honest recipients; it does not defeat an
adversary who knows the technique.

### Cleans documents without breaking them

Removing invisible characters sounds trivial and is not. Measured on the naive
approach:

```
family emoji  👨‍👩‍👧  ->  three separate people
heart  ❤️ (U+FE0F)  ->  a plain dingbat
Persian  می‌خواهم    ->  a different word
```

Zero-width joiners are how Arabic, Persian and the Indic scripts spell ordinary
words. So the cleaner decides per character, in context: the safe level keeps
what a script genuinely needs and tells you exactly what it kept and that a
mark hidden there survives; the aggressive level removes everything and tells
you what it may have broken. Neither is silent.

### Verifies C2PA content credentials

Some tools — Anthropic, Adobe, Leica, Google — attach a signed provenance
manifest to files they produce. Unlike the sampling watermark this needs no
secret, so it can actually be checked here. Covers PDF, images, audio, video.

The report never collapses into one tick:

```
Integrity   Intact — the file matches what was signed
Trust       Signer is not recognised — the claimed origin is unverified
```

That separation is the whole point. Anyone can mint a certificate whose common
name reads "Adobe Inc."; the signature then verifies perfectly while the claimed
origin is fiction. A single green check would make this tool a laundering
service for forged credentials.

Tampering is reported as **broken integrity**, never as "no credential" — a file
whose bytes changed after signing must not come back looking clean. And an
absent credential claims nothing: most files carry none, and saving or
converting usually strips it.

C2PA also carries the IPTC field a manifest uses to declare generative-AI
authorship, so that is surfaced directly.

### Shows its work

A heatmap over the document, per-segment scores, a findings list with
recommended actions, and a full technical report in Markdown you can download or
print to PDF.

---

## What it cannot do

**It cannot tell you who wrote something.** The style score measures *register* —
how much the prose resembles unedited assistant output — not authorship. It is
unreliable below ~150 words, on translated text, on non-native writing and on
lightly edited generated output. Those failure modes fall hardest on people
writing in a second language, who are least able to contest an automated
accusation.

**A clean result proves nothing.** Normalising a document strips every covert
channel this tool can see. And PDF destroys them by construction — measured:

```
DOCX -> U+200B x6, U+200D x3   PRESERVED
PDF  -> U+200B x0, U+200D x0   LOST
```

When the input is a PDF the app says so in `warnings`, because a clean result
there carries no information at all.

**Do not use a score as the sole basis for an accusation, a grade or a
disciplinary decision.** [`docs/detection-methods.md`](docs/detection-methods.md)
sets out every known failure mode; the app repeats them wherever numbers appear.

---

## How it is built

| Path | What it is |
| --- | --- |
| [`analysis-space/`](analysis-space/) | FastAPI engine — Unicode scanning, payload decoders, canary marking, context-aware sanitising, C2PA verification, stylometry, report builder. Runs on a Hugging Face Space. |
| [`worker/`](worker/) | Cloudflare Worker API — routing, validation, auth, rate limiting, job orchestration, D1/KV/R2. Marking, sanitising and credential checks are stateless and store nothing. |
| [`space-static/`](space-static/) | The same engine compiled to WebAssembly, running under Pyodide. The page loads the Python and analyses the document in the tab — nothing is uploaded, and no server is involved. `build.py` copies the modules from `analysis-space/tpl`; they are never edited here. |
| [`web/`](web/) | Next.js 14 frontend, static export, Cloudflare Pages. |
| [`shared/`](shared/) | TypeScript types shared by Worker and frontend. |
| [`examples/`](examples/README.md) | Six watermarked documents with measured results. |
| [`docs/`](docs/) | Architecture, API spec, database schema, deployment, detection methods. |

### Decisions worth knowing

**No analysis at the edge.** Cloudflare Workers allow 10 ms CPU per request. The
engine has 2 vCPU with no per-request cap, so all computation lives there. Time
the Worker spends waiting is I/O, which does not count against its budget.

**No Queues on the free plan**, so durability comes from the database plus a cron
trigger. A job that fails with attempts remaining goes back to `pending`; a
five-minute sweep retries it. Proven in production — the event log during an
outage:

```
19:40:15  analysis.created            attempt 1 → 404
19:45:35  analysis.retry  attempt=2   → 404      ← cron, to the minute
19:50:35  analysis.retry  attempt=3   → 404
19:50:37  analysis.failed                        ← budget spent, readable error
```

**Static export, not `next-on-pages`.** Nothing needs server rendering: the
browser holds its own token and fetches its own data.

**No accounts.** A workspace is an anonymous namespace identified by an
HMAC-signed token in your browser. No email, no password, no personal data,
nothing to breach. Losing the token loses the history — the Settings page says so.

---

## Run it yourself

```bash
git clone https://github.com/Mati83mon/Watermark_Finder.git
cd Watermark_Finder && npm install

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

### Use the API directly

```bash
API=https://watermark-finder-api.pennypicher-api.workers.dev

TOKEN=$(curl -s -X POST $API/api/session | jq -r .token)

ID=$(curl -s -X POST $API/api/analyses \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"...","mode":"forensic"}' | jq -r .id)

curl -s -H "authorization: Bearer $TOKEN" "$API/api/analyses/$ID" \
  | jq '{watermark: .result.scores.watermark, payloads: .result.payloads}'
```

Full contract: [`docs/api-spec.md`](docs/api-spec.md).

---

## Tests

```bash
npm test                                  # Worker (78) + web (52)
cd analysis-space && pytest               # engine (172)
python examples/generate.py --verify      # the six examples
```

302 tests. The Worker's D1 is a **real** in-memory SQLite database running the
production migration files, so the SQL is genuinely executed rather than mocked.
An end-to-end suite drives the real Worker against the real Python engine:

```bash
cd analysis-space && TPL_API_TOKEN=e2e-secret uvicorn app:app --port 7860 &
cd worker && npx tsx test/e2e.manual.ts   # 37 checks
```

CI runs all four suites on every push, on any branch, and separately proves the
browser bundle still stands on its own — `space-static/build.py --verify` drives
mark, analyse and sanitize in an interpreter with nothing installed, so a
dependency WebAssembly cannot load fails there rather than in a visitor's tab.

The two deploy workflows are separate and gated: without Cloudflare or Hugging
Face credentials they skip with an explanation in the run summary rather than
failing, so a fork of this repository shows a green CI badge and no phantom
deployment errors.

---

## Cost

Everything on Cloudflare — Pages, Workers, D1, KV, R2 — stays inside free
allowances.

Hugging Face has one rule worth knowing before you deploy your own copy: static
Spaces are free for everyone, but Gradio and Docker Spaces on free `cpu-basic`
require a PRO account, and the restriction covers downgrading an existing Space,
not only creating one.

That is a billing rule, not a resource requirement. Measured on the deployed
code:

```
RSS after boot            49.3 MB     # the free 16 GB tier is ~330x this
forensic, 1.4 kB           8.2 ms     # uvicorn --workers 1, so 2 vCPU is ample
```

The browser build avoids the question altogether: a static Space costs nothing
on any account, and the analysis runs in the visitor's tab rather than on a
server at all.

[`docs/deployment.md`](docs/deployment.md) has the exact API response and the
options.

---

## Documentation

| Document | Contents |
| --- | --- |
| [`examples/README.md`](examples/README.md) | Six worked examples with code and measured results |
| [`docs/detection-methods.md`](docs/detection-methods.md) | How each detector works and exactly where it fails |
| [`docs/architecture.md`](docs/architecture.md) | Component design, request flow, retry model, free-tier budget |
| [`docs/api-spec.md`](docs/api-spec.md) | Every endpoint, the full result schema, error codes |
| [`docs/database.md`](docs/database.md) | D1 tables, indexes, migration workflow |
| [`docs/deployment.md`](docs/deployment.md) | Step-by-step deployment and troubleshooting |

## License

MIT — see [LICENSE](LICENSE).
