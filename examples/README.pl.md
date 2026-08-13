# Przykłady

Sześć dokumentów, po jednym na detektor. **[Przetestuj na watermark-finder.pages.dev](https://watermark-finder.pages.dev)** —
wgraj plik `.txt` albo wklej jego zawartość; obie drogi zachowują ukryte znaki.

🇬🇧 [This page in English](README.md)

Każdy plik powstaje z [`generate.py`](generate.py) z tego samego akapitu bazowego,
więc wynik stylometrii jest we wszystkich sześciu identyczny (85%) i różni się
wyłącznie kanał ukryty. Dzięki temu każdy plik izoluje dokładnie jeden detektor.

## Wyniki zmierzone na działającej usłudze

| Plik | Watermark | Werdykt | Styl | Odzyskany payload |
| --- | --- | --- | --- | --- |
| [`01-clean.txt`](01-clean.txt) | 0% | `clean` | 85% | — |
| [`02-marker-zero-width.txt`](02-marker-zero-width.txt) | 92% | `watermark_detected` | 85% | — |
| [`03-payload-tag-characters.txt`](03-payload-tag-characters.txt) | 98% | `payload_recovered` | 85% | `owner:Mateusz\|release:2026-08-13\|id:WF-001` |
| [`04-payload-variation-selectors.txt`](04-payload-variation-selectors.txt) | 98% | `payload_recovered` | 85% | `leak-trace-42` |
| [`05-payload-zero-width-binary.txt`](05-payload-zero-width-binary.txt) | 99% | `payload_recovered` | 85% | `wm:demo-2026` |
| [`06-homoglyphs.txt`](06-homoglyphs.txt) | 65% | `watermark_suspected` | 85% | — |

Powtórz u siebie:

```bash
python examples/generate.py --verify
```

---

## 01 — Próba kontrolna, czysty tekst

Bez znaku wodnego. Dowodzi, że czysty dokument dostaje 0%, a nie że narzędzie
znajduje coś we wszystkim.

```python
count = sum(1 for c in text if not c.isprintable())
# 4  -> tylko znaki nowej linii
```

**Oczekiwane:** `clean`, „No covert channel found". Jeśli ten plik kiedykolwiek
dostanie więcej niż zero na osi watermarku, detektor ma problem z fałszywymi
trafieniami.

---

## 02 — Znaczniki zerowej szerokości, bez wiadomości

`U+200B` po co dziewiątej spacji, `U+200D` po co czternastej.

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

To watermark **znacznikowy**: identyfikuje dokument, ale nie niesie treści.

**Oczekiwane:** `watermark_detected` 92% i **żadnego payloadu**. Silnik dodatkowo
raportuje, że nośniki są równomiernie rozstawione — mechaniczny rytm odróżnia
celowe kodowanie od znaków złapanych przy kopiowaniu.

> Ten przykład istnieje z powodu prawdziwego błędu. Czytane jako bity te
> znaczniki dekodowały się do `\xff\xff\xff`, czyli `ÿÿÿ` w Latin-1, co
> przechodziło test drukowalności — i aplikacja ogłaszała odzyskany payload,
> którego nigdy nie było. Zmyślenie wiadomości jest gorsze niż jej przeoczenie.
> Dekoder wymaga teraz, by wynik wyglądał jak język — ale **tylko dla kanału
> binarnego**, bo tag characters i variation selectors mapują jeden kod na jeden
> bajt z definicji. Zobacz
> [`test_preprocessing.py`](../analysis-space/tests/test_preprocessing.py).

---

## 03 — Wiadomość w znakach tagowych Unicode

`U+E0000 + n` nie renderuje się wcale i odpowiada kodowi ASCII `n`.

```python
message = "owner:Mateusz|release:2026-08-13|id:WF-001"
hidden = "".join(chr(0xE0000 + ord(c)) for c in message)
watermarked = text + hidden
```

**Oczekiwane:** `payload_recovered` 98%, wiadomość odzyskana co do znaku,
severity `critical`. Raport cytuje odzyskany ciąg i podaje offsety nośników.

---

## 04 — Wiadomość w variation selectors

Bajt `b` to `U+FE00 + b` dla `b < 16`, w przeciwnym razie `U+E0100 + b - 16` —
pełny alfabet 256 wartości, więc zmieści się dowolny payload UTF-8, schowany za
jednym widocznym znakiem.

```python
message = "leak-trace-42"
hidden = "".join(
    chr(0xFE00 + b) if b < 16 else chr(0xE0100 + b - 16)
    for b in message.encode("utf-8")
)
```

**Oczekiwane:** `payload_recovered` 98%, `leak-trace-42`.

---

## 05 — Wiadomość jako binarny zapis zerowej szerokości

`U+200B` to `0`, `U+200C` to `1`, osiem bitów na bajt.

```python
message = "wm:demo-2026"
bits = "".join(f"{b:08b}" for b in message.encode("utf-8"))
hidden = "".join("​" if bit == "0" else "‌" for bit in bits)
```

Różne narzędzia przypisują symbole inaczej, więc silnik próbuje sześciu znanych
par i zostawia kandydata, który dekoduje się do najbardziej prawdopodobnego
tekstu.

**Oczekiwane:** `payload_recovered` 99%, `wm:demo-2026`.

Porównaj z przykładem 02: ten sam *rodzaj* znaków, ale tutaj naprawdę jest
wiadomość, więc się dekoduje. Dokładnie to rozróżnienie zachowuje poprawka
opisana wyżej.

---

## 06 — Podmiana na homoglify

Litery cyrylicy udające łacińskie wewnątrz łacińskich wyrazów:
`systemów` → `systе­mów` (cyrylickie `е`, `U+0435`).

```python
text.replace("systemów", "systе" + "mów")   # U+0435 zamiast U+0065
```

**Oczekiwane:** `watermark_suspected` 65%, sygnał `homoglyph_substitution`, każda
podmiana wypisana z offsetem, kodem znaku i literą łacińską, którą imituje.

Celowo niżej niż odzyskany payload: trzy podmienione litery to mocna przesłanka,
ale nie dowód — i wynik to odzwierciedla.

Wyraz w całości cyrylicki **nie jest** zgłaszany — to normalny rosyjski tekst, a
nie podmiana. Liczy się tylko znak spoza łacinki wewnątrz łacińskiego wyrazu.

---

## Ważne: PDF niszczy znaki wodne

Zmierzone, nie założone. Ten sam tekst przez dwa kontenery:

```
DOCX -> U+200B x6, U+200D x3   ZACHOWANE
PDF  -> U+200B x0, U+200D x0   UTRACONE
        odzyskane: 'Analiza systém■ow ... kluczowe■ znaczenie'
```

PDF przechowuje rozmieszczone glify, a nie strumień znaków. Kod bez glifu nie ma
czego zapisać, więc znika — albo zostawia po sobie prostokąt zastępczy.

**Wgrywaj `.txt` lub `.docx`, albo wklej tekst. Nigdy PDF**, jeśli testujesz
obecność ukrytych znaków. Gdy wejściem *jest* PDF, aplikacja mówi o tym teraz
w `warnings`: czysty wynik na PDF nie dowodzi niczego o oryginalnym pliku.

---

## Czego te przykłady nie pokazują

Każdy plik powyżej dostaje 85% na osi stylu, bo wszystkie dzielą jeden akapit
bazowy w rejestrze asystenckim. Ta liczba to **prawdopodobieństwo dotyczące
rejestru pisania, nie autorstwa** — nie powie Ci, kto coś napisał.

Wynik stylometrii jest niewiarygodny poniżej ~150 słów, na tekstach tłumaczonych,
pisanych przez osoby nieanglojęzyczne oraz na lekko zredagowanym wyjściu modelu.
[`docs/detection-methods.md`](../docs/detection-methods.md) opisuje wszystkie
znane tryby awarii.

Wyniki watermarku to twierdzenie innego rodzaju: to fakty o bajtach dokumentu,
odtwarzalne fragmentami kodu powyżej.
