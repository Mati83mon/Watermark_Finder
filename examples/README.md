# Examples

Six documents, one per detector. **[Try them at watermark-finder.pages.dev](https://watermark-finder.pages.dev)** —
upload the `.txt` file or paste its contents; both preserve hidden characters.

🇵🇱 [Ta strona po polsku](README.pl.md)

Every file is produced by [`generate.py`](generate.py) from the same base
paragraph, so the style score is identical across all six (85%) and only the
covert channel differs. That isolates exactly one detector per file.

## Results, measured on the live service

| File | Watermark | Verdict | Style | Payload recovered |
| --- | --- | --- | --- | --- |
| [`01-clean.txt`](01-clean.txt) | 0% | `clean` | 85% | — |
| [`02-marker-zero-width.txt`](02-marker-zero-width.txt) | 92% | `watermark_detected` | 85% | — |
| [`03-payload-tag-characters.txt`](03-payload-tag-characters.txt) | 98% | `payload_recovered` | 85% | `owner:Mateusz\|release:2026-08-13\|id:WF-001` |
| [`04-payload-variation-selectors.txt`](04-payload-variation-selectors.txt) | 98% | `payload_recovered` | 85% | `leak-trace-42` |
| [`05-payload-zero-width-binary.txt`](05-payload-zero-width-binary.txt) | 99% | `payload_recovered` | 85% | `wm:demo-2026` |
| [`06-homoglyphs.txt`](06-homoglyphs.txt) | 65% | `watermark_suspected` | 85% | — |

Reproduce locally:

```bash
python examples/generate.py --verify
```

---

## 01 — Clean control

No watermark. Establishes that a clean document scores 0% rather than the tool
finding something in everything.

```python
count = sum(1 for c in text if not c.isprintable())
# 4  -> only newlines
```

**Expected:** `clean`, `No covert channel found`. If this file ever scores above
zero on the watermark axis, the detector has a false-positive problem.

---

## 02 — Zero-width markers, no message

`U+200B` after every ninth space, `U+200D` after every fourteenth.

```python
out, spaces = [], 0
for char in text:
    out.append(char)
    if char == " ":
        spaces += 1
        if spaces % 9 == 0:
            out.append("​")      # ZERO WIDTH SPACE
        elif spaces % 14 == 0:
            out.append("‍")      # ZERO WIDTH JOINER
```

This is a **marker** watermark: it identifies a document but carries no message.

**Expected:** `watermark_detected` 92%, **and no payload**. The engine also
reports that the carriers are evenly spaced — mechanical spacing is what
separates a deliberate encoding from characters picked up by copy-paste.

> This example exists because of a real bug. Read as bits, those markers decoded
> to `\xff\xff\xff`, whose Latin-1 rendering `ÿÿÿ` passed the printable check, so
> the app announced a recovered payload that never existed. Announcing a message
> that is not there is worse than missing one. The decoder now demands output
> that looks like language — for the zero-width binary channel only, since tag
> characters and variation selectors map one codepoint to one byte by
> definition. See [`test_preprocessing.py`](../analysis-space/tests/test_preprocessing.py).

---

## 03 — Message in Unicode tag characters

`U+E0000 + n` renders as nothing and maps to ASCII codepoint `n`.

```python
message = "owner:Mateusz|release:2026-08-13|id:WF-001"
hidden = "".join(chr(0xE0000 + ord(c)) for c in message)
watermarked = text + hidden
```

**Expected:** `payload_recovered` 98%, message decoded verbatim, severity
`critical`. The report quotes the recovered string and gives the carrier offsets.

---

## 04 — Message in variation selectors

Byte `b` becomes `U+FE00 + b` for `b < 16`, otherwise `U+E0100 + b - 16` — a full
256-value alphabet, so any UTF-8 payload fits behind a single visible character.

```python
message = "leak-trace-42"
hidden = "".join(
    chr(0xFE00 + b) if b < 16 else chr(0xE0100 + b - 16)
    for b in message.encode("utf-8")
)
```

**Expected:** `payload_recovered` 98%, `leak-trace-42`.

---

## 05 — Message as zero-width binary

`U+200B` is `0`, `U+200C` is `1`, eight bits per byte.

```python
message = "wm:demo-2026"
bits = "".join(f"{b:08b}" for b in message.encode("utf-8"))
hidden = "".join("​" if bit == "0" else "‌" for bit in bits)
```

Different tools assign the symbols differently, so the engine tries six known
pairings and keeps the candidate that decodes to the most plausible text.

**Expected:** `payload_recovered` 99%, `wm:demo-2026`.

Contrast with example 02: the same *kind* of character, but here it really is a
message, so it decodes. That is the distinction the fix above preserves.

---

## 06 — Homoglyph substitution

Cyrillic letters standing in for Latin ones inside otherwise-Latin words:
`systemów` → `systе­mów` (Cyrillic `е`, `U+0435`).

```python
text.replace("systemów", "systе" + "mów")   # U+0435 instead of U+0065
```

**Expected:** `watermark_suspected` 65%, signal `homoglyph_substitution`, each
substitution listed with its offset, codepoint and the Latin letter it imitates.

Scored lower than a decoded payload on purpose: three swapped letters are strong
evidence but not proof, and the score says so.

A fully Cyrillic word is **not** flagged — that is ordinary Russian text, not a
substitution. Only a non-Latin character inside a Latin word counts.

---

## Important: PDF destroys watermarks

Measured, not assumed. The same text through two containers:

```
DOCX -> U+200B x6, U+200D x3   PRESERVED
PDF  -> U+200B x0, U+200D x0   LOST
        extracted: 'Analiza systém■ow ... kluczowe■ znaczenie'
```

PDF stores positioned glyphs, not a character stream. A codepoint with no glyph
has nothing to store, so it disappears — or leaves a substitution box.

**Upload `.txt` or `.docx`, or paste the text. Never PDF**, if you are testing for
hidden characters. When the input *is* a PDF the app now says so in `warnings`:
a clean covert-channel result on a PDF proves nothing about the original file.

---

## What these examples do not show

Every file above scores 85% on the style axis, because they share one
assistant-register base paragraph. That number is a **probability about writing
register, not about authorship** — it cannot tell you who wrote something.

The style score is unreliable below ~150 words, on translated text, on
non-native writing and on lightly edited generated output.
[`docs/detection-methods.md`](../docs/detection-methods.md) sets out every known
failure mode.

The watermark results are a different kind of claim: they are facts about the
bytes of the document, reproducible by the snippets above.
