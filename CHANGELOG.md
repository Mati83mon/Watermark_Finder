# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- **Repetition-stamp detection.** A watermark drawn in white text, behind the
  content or off the page is invisible when rendered and completely present once
  a PDF has been through text extraction, arriving as one phrase repeated back to
  back. It is now scored in a new `structural` signal category, which counts as
  byte evidence and is not subject to the ceiling that caps stylistic hints.

  Contiguity is the discriminator, not the count. Over a calibration set — a song
  refrain, a footer across twelve pages, a contract clause, a product catalogue,
  an ebook, this project's own README — every legitimate repetition is spread
  through the document and produces a longest back-to-back run of one, while a
  stamped mark ran to 43. Coverage could not separate them: the refrain reached
  43% against the stamp's 51%.

### Fixed

- A document carrying such a stamp scored 31.5% and `weak_indicators` while the
  findings list showed the phrase 43 times. The evidence was filed as stylistic
  and multiplied by the 0.45 cap, so the headline could never reflect what had
  actually been found. It now reports `watermark_detected` with `basis: bytes`.

## [1.0.0] — 2026-09-05

First stable release. The application is deployed and working at
<https://watermark-finder.pages.dev>.

### Detection

- Deterministic scanning for Unicode covert channels: zero-width characters,
  the Unicode tag block, variation selectors, bidi controls, exotic whitespace
  and homoglyph substitution. Every finding carries the character offset, the
  codepoint, its Unicode name and the surrounding context.
- Payload recovery from tag characters, variation selectors (a 256-value
  alphabet) and zero-width binary across six symbol pairings. A marker carrying
  no message is reported as detected with no payload claimed.
- Stylometry over eighteen weighted features, reported with a plausible range, a
  confidence level and the per-feature contributions behind the number. Below
  150 words the score is pulled toward 50%; below 15 it refuses a verdict.
- A heatmap over the document, per-segment scores, and a technical report in
  Markdown.

### Marking

- One traceable copy per recipient, spread across sentence boundaries so a
  quoted excerpt still carries the mark. Each copy is verified by decoding the
  mark back out before it is returned.

### Sanitising

- Context-aware removal that keeps the zero-width joiners Arabic, Persian and
  the Indic scripts need to spell ordinary words, and reports what it kept,
  removed or replaced. The aggressive level removes everything and names what it
  may have broken. Neither level is silent.

### Content credentials

- C2PA verification for PDF, images, audio and video against the official trust
  list, vendored as 30 anchors. Integrity and trust are reported as separate
  fields, so a valid signature from an unrecognised issuer can never read as a
  verified origin. Tampering is reported as broken integrity, never as an absent
  credential.
- The IPTC field declaring generative-AI authorship is surfaced directly.

### Browser build

- `space-static/` runs the same Python engine under Pyodide, entirely in the
  page. Nothing is uploaded because there is no server to upload to. The modules
  are copied from `analysis-space/tpl/`, never rewritten, and CI proves the
  bundle still imports with nothing installed.
- C2PA and PDF/DOCX extraction are not part of the browser build; both need
  native libraries WebAssembly cannot load.

### Platform

- Cloudflare Pages (Next.js static export), Cloudflare Worker (Hono, D1/KV/R2)
  and a Hugging Face Space (FastAPI, Python 3.11).
- Anonymous workspaces: an HMAC-signed token in the browser, no account, no
  email, no personal data.
- Durability without Queues — a failed job returns to `pending` and a
  five-minute cron sweep retries it until the attempt budget is spent.

### Tests

- 296 tests: engine 166, Worker 78, frontend 52. The Worker's D1 is a real
  in-memory SQLite database running the production migrations.
- A 37-check end-to-end suite drives the real Worker against the real engine.

[1.0.0]: https://github.com/Mati83mon/Watermark_Finder/releases/tag/v1.0.0
