# Detection methods, and what they can actually tell you

Two very different kinds of claim come out of this system. Keeping them apart is
the most important thing in the whole design, so the API, the UI and this
document all separate them.

| | Covert channels | Stylometry |
| --- | --- | --- |
| Question | Are there hidden marks in these bytes? | Does this read like unedited assistant output? |
| Kind of answer | A fact about the document | A probability about register |
| Can it be wrong? | Only if the decoder is wrong | Routinely, on short, translated or edited text |
| Evidence shown | Exact offsets, codepoints, decoded payload | Feature values, z-scores, per-feature contributions |
| Sound basis for a decision? | Yes, on its own | No, never on its own |

---

## Covert channels (deterministic)

### Zero-width and format characters

`U+200B` ZWSP, `U+200C` ZWNJ, `U+200D` ZWJ, `U+2060` word joiner, `U+FEFF`,
`U+00AD` soft hyphen and relatives render as nothing in every normal viewer,
survive copy-paste, and are the standard carrier for a text watermark.

Scoring is by count, with a bonus for *regularity*: evenly spaced carriers
indicate a deliberate encoding, whereas a couple of zero-width characters picked
up from a web page do not. The gap-regularity term is
`1 - stdev(gaps)/mean(gaps)`, clipped to `[0, 1]`.

#### Emoji presentation selectors are not carriers

`U+FE0F` after a pictographic character is what makes `⚠` render as ⚠️ rather
than a dingbat. It is ordinary text, and a document containing a tick or a
warning sign was being reported as `watermark suspected` at 60% on the strength
of three of them.

The scanner now skips a selector that meets all three conditions: it is VS15 or
VS16, it directly follows a pictographic character, and it stands alone. A run
of selectors after a single base is how a payload is written, so the exemption
cannot be used to hide one — there is a test for exactly that attack.

This was an internal contradiction as much as a false positive: `tpl.sanitize`
already refused to remove these characters, calling them "emoji presentation,
not a carrier", while the scanner called the same bytes "the standard carriers
for text watermarks". Both statements shipped in the same release. The rule now
lives in `unicode_tables.is_presentation_selector` and both modules read it.

### Decoded payloads

Three encodings are decoded outright. A successful decode floors the watermark
score at 0.95 and produces a `critical` finding.

| Channel | Encoding |
| --- | --- |
| Unicode tag characters | `U+E0000 + n` maps to ASCII `n`. Invisible everywhere. |
| Variation selectors | byte `b` → `U+FE00+b` for `b<16`, else `U+E0100+(b-16)`. A full 256-value alphabet behind one visible character. |
| Zero-width binary | Two zero-width characters as 0 and 1, read in groups of eight. Six symbol assignments used by public tools are tried; the candidate with the highest printable ratio wins. |

A candidate is only reported when it decodes to at least 80 % printable
characters, which keeps random invisible noise from being presented as a message.

### Homoglyph substitution

Cyrillic `а`, Greek `ο` and similar look-alikes inside otherwise-Latin words.
Fully Cyrillic or Greek words are ignored — that is ordinary text, not a
substitution. This channel survives reformatting and re-typing far better than
zero-width characters.

### Bidi controls

`U+202E` and relatives reorder displayed text without changing the bytes. Both a
watermark carrier and a spoofing technique, so they are reported at high severity
in their own category.

### Exotic whitespace

Non-breaking, narrow and thin spaces can encode data in the gaps between words —
but they also appear naturally in anything copied from the web. Weighted at 0.5
and capped at 0.8, and only pushed higher by mechanical regularity.

### What this cannot do

Normalising a document — `unicodedata.normalize` plus stripping the invisible
categories — removes every channel above. **A clean result is not evidence that a
document was never watermarked.** The engine states this in `warnings` and in the
generated report.

---

## Content credentials (cryptographic)

C2PA is a signed manifest embedded in a file recording what produced it and what
was done to it. Anthropic attaches one to files Claude produces, as do Adobe,
Leica and others. It covers PDF, images, audio and video.

This is the only provenance signal in the modern stack a third party can verify
without a secret: the signature is checked against the certificate in the file,
and the certificate against public trust anchors.

### Integrity and trust are different questions

The library reports three states, and collapsing them into one verdict is wrong
in both directions:

| State | Integrity | Trust | Means |
| --- | --- | --- | --- |
| `Trusted` | intact | recognised | Hashes match, signer chains to a known anchor |
| `Valid` | intact | **unrecognised** | Hashes match, signer is not recognised |
| `Invalid` | broken | unknown | A hash or signature failed |

`Valid` is the dangerous one. Certificates are not scarce: anyone can issue one
whose common name reads `Adobe Inc.` and sign a file with it. The manifest then
validates perfectly and claims whatever its author chose. Presenting that as
verified provenance would make this tool a laundering service for forged
credentials, so `integrity` and `trust` are separate fields everywhere and the
UI cannot render one without the other.

### Tampering is not absence

A file modified after signing reports `present: true, integrity: broken` with
`assertion.dataHash.mismatch`. It must never report "no credential" — that path
would let anyone strip provenance by corrupting the manifest and have the tool
call the result clean. A regression test pins this, because the first tampered
fixture written for it did exactly the wrong thing: a byte flipped in the PNG
trailer made the whole file unparseable, which came back as absence.

### AI declaration

C2PA carries the IPTC `digitalSourceType` field. `trainedAlgorithmicMedia` and
its relatives mean the content was produced by a generative model, and that is
surfaced as `ai_declared`.

### What this cannot do

**Absence proves nothing.** Most files carry no credential at all, and saving,
converting, screenshotting or re-encoding strips the ones that exist. `present:
false` is a statement about the bytes in front of us, never about how the file
was made.

**A credential describes what the signer claims**, not what is true. Integrity
tells you the file has not changed since signing. Trust tells you whether the
signer is anyone in particular. Neither tells you the claim inside the manifest
is honest.

---

## Stylometry (probabilistic)

### Features

Twenty length-invariant features, each documented in `FEATURE_DOCS` and returned
with every response. The most informative:

- `sentence_length_cv` — burstiness. Human prose alternates short and long
  sentences; generated text is markedly more uniform. The strongest single
  feature, with the largest coefficient.
- `assistant_lexicon_rate` — register vocabulary (`leverage`, `seamless`,
  `kluczowe`) per 100 words.
- `discourse_marker_rate` — explicit connectives (`moreover`, `ponadto`).
- `typo_indicator_rate` — double spaces, `!!`, missing space after a comma.
  Almost never survives generation, so it points strongly the other way.
- `hedge_rate`, `contraction_rate`, `em_dash_rate`, `mattr`, `hapax_ratio`,
  `bullet_line_ratio`, and others.

English and Polish marker lists are built in; other languages fall back to the
English lists, and the response says so.

#### Fenced code blocks are excluded first

Every feature is measured on the document with ``` blocks removed, because a
listing is not the author's writing.

This was found the hard way, on this repository's own README. All 69 double-space
runs that `typo_indicator_rate` fired on sat inside fenced blocks — ASCII
diagrams and aligned output. None were in prose and none were in tables:

```
original                     13.6%   typo_indicator_rate 5.537
code blocks removed          23.8%   typo_indicator_rate 0.000
code blocks + table padding  23.8%   typo_indicator_rate 0.000   (tables add nothing)
```

Ten points of "human" bought purely by layout. The feature exists to catch the
accidental double-tap of someone typing; deliberate column alignment is the
opposite of that, and any document with a code sample — a README, a model card,
technical notes — collected the bonus regardless of who wrote it.

Whitespace was only the visible half. Sentence length, word length, vocabulary
and connective density are equally meaningless measured over source code, so a
document's prose was being averaged with a language its author never wrote.

Indented code is deliberately **not** stripped. Four-space indentation is also
how people lay out plain text, and the double-space detector already ignores
leading whitespace — it requires a non-space character on both sides.

### The model

Ships as a **documented prior**: a logistic model whose coefficients are stated
with a rationale for each, rather than fitted to a corpus. `trained: false` in
every response, and the UI labels it accordingly.

The alternative would have been to fit a model on a small bundled corpus and
present it as trained. That would have produced a more impressive-looking number
backed by nothing, so `train.py` instead refuses to emit an artefact from fewer
than 50 samples per class, and the prior is used until a real corpus exists. When
one does, `models/style_clf.joblib` is picked up automatically and
`models/metrics.json` — cross-validated accuracy, precision, recall, F1, ROC-AUC,
per-fold detail — is served by `/version` and shown next to the score.

### Calibration

Three mechanisms keep the number honest:

1. **Temperature.** The linear term is scaled by 0.45, so a maximally
   assistant-like document lands near 0.95 instead of saturating at 1.0.
2. **Shrinkage.** Below 150 words the score is pulled towards 0.5 by
   `sqrt(words/150)`. Below 15 words the verdict is `insufficient_evidence`.
3. **An interval, always.** `low`/`high` widen as the sample shrinks, and the UI
   draws the band rather than only the point estimate.

### Optional surprisal

With `TPL_ENABLE_PERPLEXITY=1`, a small local causal LM (default `distilgpt2`)
contributes mean per-token surprisal and its coefficient of variation. Sampled
text sits in a lower-surprisal, flatter region than spontaneous human writing.
Blended at 30 % weight and always reported with the model that produced it.
Off by default: it adds ~700 MB to the image and does not change the verdict on
most documents.

### Style resemblance profiles

Five profiles — structured assistant, prose assistant, marketing copy, unedited
human, edited human — matched on directional trait constraints. Similarity is
capped at 0.85 and every match carries `speculative: true`.

**These do not identify a model.** No public method can attribute text to a
specific vendor's model from the text alone. The profiles describe formatting and
register habits; the disclaimer travels with the data.

### Known failure modes

| Situation | Effect |
| --- | --- |
| Under ~150 words | Unreliable; shrunk toward 0.5, wide band |
| Translated text | Translation flattens burstiness and strips typos → false positive |
| Non-native English | Similar mechanism → false positive. This is a documented fairness problem in AI-text detection generally |
| Edited generated text | Light human editing restores burstiness → false negative |
| Technical documentation | Legitimately list-heavy and uniform → false positive |
| Formal legal or academic prose | Register overlaps with assistant output → false positive |
| A model told to write casually | Defeats several features at once → false negative |

---

## Using this responsibly

A recovered payload is a fact worth acting on. A style score is a reason to look
closer — nothing more.

If you are considering a decision that affects someone (a grade, a hiring call, a
disciplinary step), the style score cannot carry it. Corroborate with document
history, drafts, version control, or a conversation. The false-positive modes
above fall hardest on people writing in a second language, which is exactly the
population least able to contest an automated accusation.

Every response carries these caveats in `warnings`; the report ends with a
limitations section; the UI repeats them in the footer and on the Settings page.
They are part of the output, not a disclaimer bolted on afterwards.
