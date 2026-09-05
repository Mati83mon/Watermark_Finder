# Watermark Finder

**→ [watermark-finder.pages.dev](https://watermark-finder.pages.dev) — w pełni działająca aplikacja webowa. Bez rejestracji, bez instalacji.**

**→ [Wersja przeglądarkowa](https://huggingface.co/spaces/Mati83moni/watermark-finder) — ten sam silnik pod WebAssembly. Dokument nie opuszcza Twojej karty.**

[![CI](https://github.com/Mati83mon/Watermark_Finder/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Mati83mon/Watermark_Finder/actions/workflows/ci.yml)
[![Licencja: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

🇬🇧 [This document in English](README.md) · [Przykłady z prawdziwymi wynikami](examples/README.pl.md)

Oznacz dokument niewidocznie, znajdź znak w dokumencie, który dostałeś, albo
usuń go, zanim przekażesz dokument dalej. Znaki zerowej szerokości, payloady w
znakach tagowych Unicode, podmiany na homoglify. Ocenia też, na ile tekst czyta
się jak niezredagowane wyjście asystenta — z głośnymi zastrzeżeniami, bo ta
część mierzy rejestr, nie autorstwo.

```
ZNAKUJ  ────────────►  WYKRYJ  ────────────►  WYCZYŚĆ
jedna kopia do         ukryte znaki,          usuń nośniki
śledzenia na odbiorcę  poświadczenia C2PA     nie psując tekstu
```

```
Pages (Next.js)  →  Worker (Hono + D1/KV/R2)  →  Space (FastAPI + Python)
   frontend            API, zadania, storage        cała analiza
```

---

## Sprawdź w 30 sekund

Wklej to do [aplikacji](https://watermark-finder.pages.dev). Wygląda jak zwykłe
zdanie — nie jest:

```python
message = "owner:Mateusz|id:WF-001"
hidden  = "".join(chr(0xE0000 + ord(c)) for c in message)
print("Analiza systemów autonomicznych wskazuje na kluczowe znaczenie." + hidden)
```

Aplikacja odpowiada `payload_recovered`, **98%**, i wypisuje z powrotem
`owner:Mateusz|id:WF-001` wraz z dokładnymi offsetami znaków nośnikowych.

Wolisz pliki? W [`examples/`](examples/README.pl.md) czeka sześć gotowych
dokumentów, po jednym na detektor, z wynikami, jakie każdy powinien dać.

---

## Co robi

### Znajduje ukryte znaki — deterministycznie

| Kanał | Na czym polega | Przykładowy wynik |
| --- | --- | --- |
| Znaki tagowe Unicode | `U+E0000 + n` odpowiada ASCII `n`, nie renderuje się wcale | `payload_recovered` 98%, wiadomość zacytowana |
| Variation selectors | bajt `b` → `U+FE00+b` / `U+E0100+b-16`, alfabet 256 wartości | `payload_recovered` 98% |
| Binarny zapis zerowej szerokości | `U+200B` = 0, `U+200C` = 1, sześć par symboli sprawdzanych | `payload_recovered` 99% |
| Znaczniki zerowej szerokości | symbol w stałych odstępach, bez treści | `watermark_detected` 92%, **bez zmyślonego payloadu** |
| Homoglify | cyrylickie `е` wewnątrz łacińskiego wyrazu | `watermark_suspected` 65% |
| Kontrolki bidi, egzotyczne spacje | kanały przez kolejność i odstępy | zgłaszane z offsetami |

To są fakty o bajtach dokumentu, nie domysły. Każde znalezisko ma dokładny
offset znaku, jego kod, nazwę Unicode i kontekst wokół.

### Ocenia rejestr pisania — probabilistycznie, z widoczną niepewnością

Osiemnaście cech stylometrycznych — zmienność długości zdań, gęstość spójników,
słownictwo rejestru, profil błędów — na listach markerów polskich i angielskich.

Każdy wynik niesie przedział ufności, poziom pewności i wkład poszczególnych
cech, które go wyprodukowały:

```
STYL   0.86  [0.51–1.00]  very_likely_ai  pewność: low

  assistant_lexicon_rate   z=+2.50  → asystent
  discourse_marker_rate    z=+2.50  → asystent
  sentence_length_cv       z=-1.83  → asystent
```

Poniżej 150 słów wynik jest ściągany w stronę 50%; poniżej 15 słów aplikacja
w ogóle odmawia werdyktu i zwraca `insufficient_evidence`.

### Znakuje dokumenty, żeby dało się namierzyć wyciek

Wklejasz poufny draft, wpisujesz listę odbiorców i dostajesz po jednej kopii na
osobę. Kopie czytają się identycznie, każda niesie inny niewidoczny numer.

```
Jan Kowalski     WF-001    +14 znaków   odczyt zwrotny ✓
Anna Nowak       WF-002    +14 znaków   odczyt zwrotny ✓
Piotr Wiśniewski WF-003    +14 znaków   odczyt zwrotny ✓
```

Każda kopia jest sprawdzana przez odkodowanie znaku z powrotem, zanim trafi do
Ciebie. Znaki są rozproszone po granicach zdań, więc zacytowany fragment nadal
je niesie — w testach fragment 50% dokumentu odtwarza cały payload.

Znak nie jest tajny: każdy z tym narzędziem go odczyta, a jego własny
sanityzator go usuwa. Śledzi uczciwych odbiorców, nie pokonuje przeciwnika,
który zna technikę.

### Czyści dokumenty, nie psując ich

Usuwanie niewidocznych znaków brzmi trywialnie i takie nie jest. Zmierzone na
naiwnym podejściu:

```
rodzina emoji  👨‍👩‍👧  ->  trzy osobne osoby
serce  ❤️ (U+FE0F)  ->  zwykły glif
perskie  می‌خواهم   ->  inne słowo
```

Złączenia zerowej szerokości to sposób, w jaki arabski, perski i pisma
indyjskie zapisują zwykłe wyrazy. Dlatego sanityzator decyduje per znak, w
kontekście: poziom bezpieczny zachowuje to, czego pismo naprawdę potrzebuje, i
mówi wprost, co zachował oraz że znak ukryty w tym miejscu przetrwa; poziom
agresywny usuwa wszystko i mówi, co mógł zepsuć. Żaden nie milczy.

### Weryfikuje poświadczenia C2PA

Część narzędzi — Anthropic, Adobe, Leica, Google — dołącza do plików podpisany
manifest pochodzenia. W przeciwieństwie do watermarku samplingowego nie wymaga
to żadnego sekretu, więc da się to naprawdę sprawdzić. Obejmuje PDF, obrazy,
audio i wideo.

Raport nigdy nie sprowadza tego do jednej fajki:

```
Integralność   Nienaruszona — plik zgadza się z tym, co podpisano
Zaufanie       Podpisujący nierozpoznany — deklarowane pochodzenie niezweryfikowane
```

To rozdzielenie jest sednem. Każdy może wystawić certyfikat, w którym nazwa
brzmi „Adobe Inc."; podpis wtedy przechodzi bez zarzutu, a deklarowane
pochodzenie jest fikcją. Jedna zielona fajka zamieniłaby to narzędzie w pralnię
podrobionych poświadczeń.

Manipulacja jest raportowana jako **naruszona integralność**, nigdy jako „brak
poświadczenia" — plik, którego bajty zmieniono po podpisaniu, nie może wyglądać
na czysty. A brak poświadczenia nie dowodzi niczego: większość plików go nie ma,
a zapis albo konwersja zwykle je usuwa.

C2PA niesie też pole IPTC, którym manifest deklaruje autorstwo generatywnej AI —
pokazujemy je wprost.

### Pokazuje, skąd wziął wynik

Heatmapa na dokumencie, wyniki per segment, lista znalezisk z zalecanymi
działaniami i pełny raport techniczny w Markdown do pobrania albo wydruku do PDF.

---

## Czego nie potrafi

**Nie powie Ci, kto coś napisał.** Wynik stylometrii mierzy *rejestr* — na ile
tekst przypomina niezredagowane wyjście asystenta — a nie autorstwo. Jest
niewiarygodny poniżej ~150 słów, na tekstach tłumaczonych, pisanych przez osoby
nieanglojęzyczne i na lekko zredagowanym wyjściu modelu. Te tryby awarii
najmocniej uderzają w osoby piszące w drugim języku, które mają najmniejsze
możliwości zakwestionowania automatycznego oskarżenia.

**Czysty wynik niczego nie dowodzi.** Normalizacja dokumentu usuwa każdy kanał
ukryty, jaki to narzędzie widzi. A PDF niszczy je z samej swojej konstrukcji —
zmierzone:

```
DOCX -> U+200B x6, U+200D x3   ZACHOWANE
PDF  -> U+200B x0, U+200D x0   UTRACONE
```

Gdy wejściem jest PDF, aplikacja mówi o tym w `warnings`, bo czysty wynik nie
niesie tam żadnej informacji.

**Nie używaj wyniku jako jedynej podstawy oskarżenia, oceny ani decyzji
dyscyplinarnej.** [`docs/detection-methods.md`](docs/detection-methods.md)
opisuje wszystkie znane tryby awarii; aplikacja powtarza je wszędzie tam, gdzie
pokazuje liczby.

---

## Jak to jest zbudowane

| Ścieżka | Co to jest |
| --- | --- |
| [`analysis-space/`](analysis-space/) | Silnik FastAPI — skanowanie Unicode, dekodery payloadów, znakowanie canary, sanityzacja świadoma kontekstu, weryfikacja C2PA, stylometria, generator raportów. Działa na Hugging Face Space. |
| [`worker/`](worker/) | API na Cloudflare Worker — routing, walidacja, autoryzacja, rate limiting, orkiestracja zadań, D1/KV/R2. Znakowanie, sanityzacja i sprawdzanie poświadczeń są bezstanowe i nic nie zapisują. |
| [`space-static/`](space-static/) | Ten sam silnik skompilowany do WebAssembly, uruchamiany przez Pyodide. Strona ładuje Pythona i analizuje dokument w karcie przeglądarki — nic nie jest wysyłane, żaden serwer nie bierze w tym udziału. `build.py` kopiuje moduły z `analysis-space/tpl`; tutaj się ich nie edytuje. |
| [`web/`](web/) | Frontend Next.js 14, eksport statyczny, Cloudflare Pages. |
| [`shared/`](shared/) | Typy TypeScript wspólne dla Workera i frontendu. |
| [`examples/`](examples/README.pl.md) | Sześć dokumentów ze znakami wodnymi i zmierzonymi wynikami. |
| [`docs/`](docs/) | Architektura, specyfikacja API, schemat bazy, wdrożenie, metody detekcji. |

### Decyzje warte poznania

**Żadnej analizy na brzegu sieci.** Cloudflare Workers dają 10 ms CPU na
żądanie. Silnik ma 2 vCPU bez limitu na żądanie, więc całe liczenie mieszka tam.
Czas, który Worker spędza na czekaniu, to I/O i nie liczy się do jego budżetu.

**Kolejek nie ma w darmowym planie**, więc trwałość zapewnia baza plus cron.
Zadanie, które padnie mając jeszcze próby, wraca do `pending`; sweep co pięć
minut je ponawia. Sprawdzone na produkcji — log zdarzeń podczas awarii:

```
19:40:15  analysis.created            próba 1 → 404
19:45:35  analysis.retry  attempt=2   → 404      ← cron, co do minuty
19:50:35  analysis.retry  attempt=3   → 404
19:50:37  analysis.failed                        ← budżet wyczerpany, czytelny błąd
```

**Eksport statyczny, nie `next-on-pages`.** Nic nie wymaga renderowania po
stronie serwera: przeglądarka trzyma własny token i pobiera własne dane.

**Zero kont.** Workspace to anonimowa przestrzeń nazw identyfikowana tokenem
podpisanym HMAC w Twojej przeglądarce. Bez e-maila, bez hasła, bez danych
osobowych, bez czegokolwiek do wycieku. Utrata tokena to utrata historii —
strona Ustawień mówi to wprost.

---

## Uruchom u siebie

```bash
git clone https://github.com/Mati83mon/Watermark_Finder.git
cd Watermark_Finder && npm install

# Silnik
cd analysis-space
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app:app --reload --port 7860      # http://127.0.0.1:7860/docs

# Worker (nowy terminal)
cd worker
cp ../infra/dev.vars.example .dev.vars
npx wrangler d1 migrations apply watermark-finder --local
npx wrangler dev                          # http://127.0.0.1:8787

# Frontend (nowy terminal)
cd web && npm run dev                     # http://localhost:3000
```

### Korzystanie z API bezpośrednio

```bash
API=https://watermark-finder-api.pennypicher-api.workers.dev

TOKEN=$(curl -s -X POST $API/api/session | jq -r .token)

ID=$(curl -s -X POST $API/api/analyses \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"...","mode":"forensic"}' | jq -r .id)

curl -s -H "authorization: Bearer $TOKEN" "$API/api/analyses/$ID" \
  | jq '{watermark: .result.scores.watermark, payloads: .result.payloads}'
```

Pełny kontrakt: [`docs/api-spec.md`](docs/api-spec.md).

---

## Testy

```bash
npm test                                  # Worker (78) + web (52)
cd analysis-space && pytest               # silnik (166)
python examples/generate.py --verify      # sześć przykładów
```

296 testów. D1 w testach Workera to **prawdziwa** baza SQLite w pamięci,
wykonująca produkcyjne pliki migracji, więc SQL jest naprawdę uruchamiany, a nie
zamockowany. Osobny zestaw end-to-end steruje prawdziwym Workerem przeciwko
prawdziwemu silnikowi w Pythonie:

```bash
cd analysis-space && TPL_API_TOKEN=e2e-secret uvicorn app:app --port 7860 &
cd worker && npx tsx test/e2e.manual.ts   # 37 sprawdzenia
```

CI uruchamia wszystkie cztery zestawy przy każdym pushu, na każdej gałęzi, i
osobno sprawdza, czy pakiet przeglądarkowy nadal stoi o własnych siłach —
`space-static/build.py --verify` przepuszcza znakowanie, analizę i sanityzację
przez interpreter bez żadnych doinstalowanych bibliotek, więc zależność, której
WebAssembly nie załaduje, padnie tam, a nie w karcie odwiedzającego.

Dwa workflowy wdrożeniowe są osobne i bramkowane: bez poświadczeń do Cloudflare
albo Hugging Face pomijają się z wyjaśnieniem w podsumowaniu przebiegu, zamiast
paść. Dzięki temu fork tego repozytorium pokazuje zieloną odznakę CI i żadnych
widmowych błędów wdrożenia.

---

## Koszty

Wszystko na Cloudflare — Pages, Workers, D1, KV, R2 — mieści się w darmowych
limitach.

Hugging Face ma jedną regułę, którą warto znać przed wdrożeniem własnej kopii:
statyczne Space'y są darmowe dla każdego, ale Gradio i Docker Space na darmowym
`cpu-basic` wymagają konta PRO, a ograniczenie obejmuje też **zejście**
istniejącego Space'a na darmowy tier, nie tylko zakładanie nowego.

To reguła rozliczeniowa, nie wymaganie zasobowe. Zmierzone na wdrożonym kodzie:

```
RSS po starcie            49.3 MB     # darmowe 16 GB to ~330x tyle
forensic, 1.4 kB           8.2 ms     # uvicorn --workers 1, więc 2 vCPU wystarczą
```

Wersja przeglądarkowa omija ten problem w całości: statyczny Space nie kosztuje
nic na żadnym koncie, a analiza działa w karcie odwiedzającego, nie na serwerze.

[`docs/deployment.md`](docs/deployment.md) zawiera dokładną odpowiedź API i
dostępne opcje.

---

## Dokumentacja

| Dokument | Zawartość |
| --- | --- |
| [`examples/README.pl.md`](examples/README.pl.md) | Sześć omówionych przykładów z kodem i zmierzonymi wynikami |
| [`docs/detection-methods.md`](docs/detection-methods.md) | Jak działa każdy detektor i gdzie dokładnie zawodzi |
| [`docs/architecture.md`](docs/architecture.md) | Projekt komponentów, przepływ żądania, model ponowień, budżet darmowych limitów |
| [`docs/api-spec.md`](docs/api-spec.md) | Każdy endpoint, pełny schemat wyniku, kody błędów |
| [`docs/database.md`](docs/database.md) | Tabele D1, indeksy, proces migracji |
| [`docs/deployment.md`](docs/deployment.md) | Wdrożenie krok po kroku i rozwiązywanie problemów |

## Licencja

MIT — zobacz [LICENSE](LICENSE).
