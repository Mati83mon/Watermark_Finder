#!/usr/bin/env python3
"""Copy the engine modules that run in the browser out of `analysis-space/`.

The static build runs the *same* Python as the server: no reimplementation, no
second set of rules to keep in step. Two copies of a decision - what counts as a
covert channel, when a joiner is load-bearing - is how a codebase starts
contradicting itself, and this project has already paid for that lesson once.

So the files here are generated, never edited, and `--check` fails the build if
they have drifted from the originals.

Excluded, because they cannot work in WebAssembly:

    api.py          FastAPI and pydantic; the browser calls the functions directly
    provenance.py   c2pa-python is a native wheel
    extraction.py   PDF and DOCX parsing, pulled in only by the upload path

Excluding them is a promise about the rest: nothing the browser loads may reach
those three, and nothing may reach a package Pyodide does not carry. Neither
promise is visible in the source - a stray `import provenance` inside a module
the bundle *does* include would pass every server test and break only in the
page. So `--verify` re-imports the bundle in an isolated interpreter with
site-packages unavailable, and drives a payload through mark, analyse and
sanitize there. That is what CI runs; the copy is generated, so `--check` alone
can only ever confirm the copy was just made.
"""

from __future__ import annotations

import filecmp
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent / "analysis-space" / "tpl"
TARGET = HERE / "tpl"

EXCLUDED = {"api.py", "extraction.py", "provenance.py"}


def modules() -> list[Path]:
    return sorted(p for p in SOURCE.glob("*.py") if p.name not in EXCLUDED)


def check() -> int:
    problems: list[str] = []
    expected = {p.name for p in modules()}
    actual = {p.name for p in TARGET.glob("*.py")}

    for missing in sorted(expected - actual):
        problems.append(f"missing from the static bundle: {missing}")
    for extra in sorted(actual - expected):
        problems.append(f"stale file in the static bundle: {extra}")
    for path in modules():
        mirror = TARGET / path.name
        if mirror.exists() and not filecmp.cmp(path, mirror, shallow=False):
            problems.append(f"drifted from analysis-space/tpl: {path.name}")

    if problems:
        print("The browser bundle no longer matches the engine:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        print("\nRun `python space-static/build.py` and commit the result.", file=sys.stderr)
        return 1
    print(f"Browser bundle matches the engine ({len(expected)} modules).")
    return 0


def build() -> int:
    TARGET.mkdir(exist_ok=True)
    for stale in TARGET.glob("*.py"):
        stale.unlink()
    total = 0
    for path in modules():
        shutil.copy2(path, TARGET / path.name)
        total += path.stat().st_size
    names = [p.name for p in modules()]
    (TARGET / "MANIFEST").write_text("\n".join(names) + "\n", encoding="utf-8")
    print(f"Copied {len(names)} modules, {total / 1024:.0f} KB")
    return 0


# Deliberately a copy of what app.js runs after Pyodide boots, down to the
# sys.path line, so the two cannot drift into testing different entry points.
PROBE = '''
import sys
sys.path.insert(0, ".")
from tpl.pipeline import analyse
from tpl.marking import mark_for_recipients
from tpl.sanitize import sanitize

original = "Pierwsze zdanie o czyms. Drugie zdanie o czyms innym. Trzecie na koniec."
copy = mark_for_recipients(
    original, ["Anna"], template="id:{recipient}", channel="tag_characters"
)[0]

result = analyse(copy.text, "forensic")
assert result["scores"]["watermark"]["label"] == "payload_recovered", result["scores"]
assert result["payloads"], "the mark went in but the scanner did not read it back"
assert "id:Anna" in result["payloads"][0]["text"], result["payloads"][0]

cleaned = sanitize(copy.text, level="safe")
assert cleaned.text == original, "sanitizing did not restore the original bytes"

print("browser bundle: mark, analyse and sanitize all work on the standard library alone")
'''


def verify() -> int:
    """Run the bundle the way the page does: no site-packages, no server modules.

    `-S` is the point. The excluded modules and every third-party package are
    absent from the interpreter, so an import the browser could not satisfy
    fails here as loudly as it would in Pyodide, instead of quietly succeeding
    against the packages the server happens to have installed.
    """
    if not (TARGET / "pipeline.py").exists():
        build()
    completed = subprocess.run(
        [sys.executable, "-I", "-S", "-c", PROBE], cwd=HERE, check=False
    )
    if completed.returncode != 0:
        print(
            "\nThe browser bundle does not run standalone. Either a module it "
            "includes\nnow reaches api.py, provenance.py or extraction.py, or "
            "something in\nanalysis-space/tpl grew a dependency Pyodide cannot "
            "load.",
            file=sys.stderr,
        )
    return completed.returncode


if __name__ == "__main__":
    if "--check" in sys.argv:
        raise SystemExit(check())
    if "--verify" in sys.argv:
        raise SystemExit(verify())
    raise SystemExit(build())
