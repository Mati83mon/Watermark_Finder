---
title: Watermark Finder
emoji: 🔍
colorFrom: indigo
colorTo: gray
sdk: static
pinned: false
license: mit
short_description: Find, place and strip hidden text watermarks
---

# Watermark Finder — in your browser

Find hidden characters in a document, mark a document so a leak can be traced,
or strip the marks out before passing it on.

The analysis engine is Python and it runs **inside the page**, compiled to
WebAssembly. Nothing you paste is uploaded: there is no server to upload it to.

## What runs here

| | |
| --- | --- |
| Hidden character detection | zero-width, Unicode tag block, variation selectors, bidi controls, exotic spaces |
| Payload recovery | decodes the hidden message and reports the exact carrier offsets |
| Homoglyph detection | non-Latin look-alikes inside otherwise-Latin words |
| Canary marking | one invisibly distinct copy per recipient, each verified by decoding it back |
| Sanitising | context-aware; keeps the joiners Arabic, Persian and the Indic scripts need |
| Stylometry | 18 documented features, with the per-feature contributions shown |

## What needs the server build

Content credentials (C2PA) rely on a native library that cannot run in
WebAssembly, and PDF/DOCX text extraction is not bundled here. Both are in the
[full version](https://watermark-finder.pages.dev).

## What this cannot tell you

The style score measures **register** — how much prose resembles unedited
assistant output — not authorship. It is unreliable on short text, translated
text and non-native writing, and those failure modes fall hardest on people
least able to contest an automated accusation. Never use it as the sole basis
for an accusation, a grade or a disciplinary decision.

A clean result proves nothing either: normalising a document removes every
covert channel this tool can see, and PDF destroys them by construction.

## Source

[github.com/Mati83mon/Watermark_Finder](https://github.com/Mati83mon/Watermark_Finder) · MIT

The Python in `tpl/` is copied from `analysis-space/tpl/` by `build.py`, not
rewritten, so the browser and the server apply the same rules. CI fails if the
two drift apart.
