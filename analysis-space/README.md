---
title: Text Provenance Lab
emoji: 🔍
colorFrom: indigo
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: Watermark and text-provenance analysis engine
---

# text-provenance-lab

Analysis engine behind Watermark Finder. Runs on a Hugging Face Space (CPU
Basic, free tier), holds no state, and makes no outbound network calls: every
model it uses is local, and most of the analysis is plain deterministic Unicode
work.

The only client is the Cloudflare Worker; the endpoints are documented so the
service can also be driven directly.

## What it measures

**Covert channels (deterministic).** Zero-width characters, Unicode tag
characters, variation-selector byte streams, bidi controls, homoglyph
substitution and exotic whitespace. Where a payload is present the engine
decodes it and reports the recovered bytes. These findings are facts about the
input, not inferences.

**Register (probabilistic).** Eighteen stylometric features - sentence-length
burstiness, lexical diversity, connective density, register vocabulary, error
profile - feed a logistic model that scores how much the text reads like
unedited assistant output. It ships with a documented coefficient prior and
switches automatically to a fitted model when `models/style_clf.joblib` exists.

**Optional surprisal.** With `TPL_ENABLE_PERPLEXITY=1` and torch/transformers
installed, a small local causal LM contributes mean surprisal and burstiness.
Off by default.

## Honest limits

- The style score measures *register*, not authorship. It cannot prove who or
  what wrote a document, and it is unreliable below ~150 words, on translated
  text, and on lightly edited generated output.
- The style-resemblance profiles describe formatting habits. They are labelled
  `speculative` in the API and must not be presented as attribution.
- A clean result proves nothing: normalising a document removes every covert
  channel this engine can see.
- Do not use the score as the sole basis for an accusation, grade or
  disciplinary action. Every response carries these caveats in `warnings` and in
  the generated report.

## API

| Method | Path            | Purpose                                        |
| ------ | --------------- | ---------------------------------------------- |
| GET    | `/health`       | Liveness probe.                                |
| GET    | `/version`      | Engine version, active style model, metrics.   |
| GET    | `/capabilities` | Limits and which optional features are active. |
| POST   | `/analyze`      | Analyse a string.                              |
| POST   | `/mark`         | One invisibly distinct copy per recipient.     |
| POST   | `/sanitize`     | Remove carriers, context-aware.                |
| POST   | `/c2pa`         | Verify a file's content credential.            |
| POST   | `/extract`      | Extract text from PDF / DOCX / HTML / TXT.     |
| GET    | `/docs`         | OpenAPI UI.                                    |

```bash
curl -s https://<space-host>/analyze \
  -H 'content-type: application/json' \
  -H "X-API-Key: $TPL_API_TOKEN" \
  -d '{"text": "...", "mode": "forensic"}' | jq '.result.scores'
```

`mode` is `quick` (coarse segmentation, no optional models) or `forensic`
(full segmentation, style profiles, surprisal when enabled).

The full response contract lives in [`docs/api-spec.md`](../docs/api-spec.md).

## Configuration

| Variable                 | Default  | Meaning                                        |
| ------------------------ | -------- | ---------------------------------------------- |
| `TPL_API_TOKEN`          | *(none)* | Shared secret for `X-API-Key`. Empty = open.   |
| `TPL_MAX_CHARS`          | `200000` | Largest analysable document.                   |
| `TPL_MAX_UPLOAD_BYTES`   | `10485760` | Largest upload accepted by `/extract`.       |
| `TPL_WINDOW_WORDS`       | `120`    | Segment size for the heatmap.                  |
| `TPL_WINDOW_OVERLAP`     | `30`     | Segment overlap.                               |
| `TPL_MAX_SEGMENTS`       | `300`    | Cap on returned segments.                      |
| `TPL_CORS_ORIGINS`       | `*`      | Comma-separated allowed origins.               |
| `TPL_ENABLE_PERPLEXITY`  | `0`      | Enable the local surprisal model.              |
| `TPL_PERPLEXITY_MODEL`   | `distilgpt2` | Model id for surprisal.                    |
| `TPL_ENABLE_GRADIO`      | `0`      | Mount a manual-testing UI at `/ui`.            |
| `TPL_LOG_LEVEL`          | `INFO`   | Log level.                                     |

Set `TPL_API_TOKEN` as a Space secret and give the Worker the same value.

## Local development

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
pytest                 # 172 tests, no network required
ruff check tpl app.py train.py tests
uvicorn app:app --reload --port 7860
```

## Training the style model

The engine works without a trained model. To fit one, put a labelled corpus in
`data/corpus/*.jsonl` (see [`data/corpus/README.md`](data/corpus/README.md)) and run:

```bash
python train.py --corpus data/corpus --out models
```

`train.py` refuses to emit an artefact from fewer than 50 samples per class,
because a model fitted on less would report confidence it cannot support. It
writes `models/style_clf.joblib` plus `models/metrics.json` (cross-validated
accuracy, precision, recall, F1, ROC-AUC, per-fold detail and coefficients),
which `/version` serves so the frontend can show where a score came from.
