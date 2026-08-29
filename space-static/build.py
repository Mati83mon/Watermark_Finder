#!/usr/bin/env python3
"""Copy the engine modules that run in the browser out of `analysis-space/`.

The static build runs the *same* Python as the server: no reimplementation, no
second set of rules to keep in step. Two copies of a decision - what counts as a
covert channel, when a joiner is load-bearing - is how a codebase starts
contradicting itself, and this project has already paid for that lesson once.

So the files here are generated, never edited, and `--check` fails the build if
they have drifted from the originals. CI runs it.

Excluded, because they cannot work in WebAssembly:

    api.py          FastAPI and pydantic; the browser calls the functions directly
    provenance.py   c2pa-python is a native wheel
    extraction.py   PDF and DOCX parsing, pulled in only by the upload path
"""

from __future__ import annotations

import filecmp
import shutil
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


if __name__ == "__main__":
    raise SystemExit(check() if "--check" in sys.argv else build())
