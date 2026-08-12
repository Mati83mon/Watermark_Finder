# Training corpus

`train.py` reads every `*.jsonl` file in this directory. One JSON object per
line:

```json
{"text": "the full document text", "label": "human", "source": "wikipedia-2019-dump"}
```

| Field    | Required | Notes                                                            |
| -------- | -------- | ---------------------------------------------------------------- |
| `text`   | yes      | Raw text. Samples under 40 words are skipped with a warning.      |
| `label`  | yes      | `human` or `ai`. Anything else aborts the run.                    |
| `source` | no       | Provenance string; recorded in `models/metrics.json`.             |

No corpus is committed to this repository. Text corpora carry licensing and
personal-data obligations that differ per jurisdiction and per source, and
shipping one inside an application repo is the wrong place to take that on.

## Building one

Both classes must come from the same domain, register and language, or the
classifier will learn the *topic* rather than the register:

- **human** — text written before mid-2022 is the cleanest baseline. Public
  domain books (Project Gutenberg, Wolne Lektury), permissively licensed
  Wikipedia dumps, your own archives.
- **ai** — output you generate yourself from open-weight models, covering a
  range of prompts, lengths and temperatures. Record which model and settings
  produced each sample in `source`.

Aim for at least 50 samples per class (`train.py` enforces this) and ideally a
few hundred, balanced, with a held-out set that never touches training.

## After training

`models/metrics.json` records cross-validated metrics, class counts, sources and
coefficients. `/version` serves it, and the frontend shows it next to any score
the trained model produced. Treat those metrics as valid only for text that
resembles the corpus — they do not transfer to another domain, language or
generator.
