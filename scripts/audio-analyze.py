#!/usr/bin/env python3
"""Summarise audio-trials.jsonl as distributions, not anecdotes.

Reports median and range per condition with an explicit n, because every wrong
conclusion in this investigation came from reading a single run as a result. A
condition with n=1 is printed with a warning rather than a number you might act
on.

Also prints the CONTROL series in run order. Control is the drift detector: if
it moves across a batch, the pool was changing underneath the batch and no
condition in it can be trusted, however clean the medians look.
"""
import json
import pathlib
import statistics
import sys

PATH = pathlib.Path(__file__).resolve().parent.parent / "docs/redesign/verify/audio-trials.jsonl"


def main() -> int:
    if not PATH.exists():
        print(f"no trials yet at {PATH}")
        return 1

    rows = []
    for line in PATH.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                print(f"skipping unparseable line: {line[:80]}", file=sys.stderr)

    kept = [r for r in rows if not r.get("discarded")]
    dropped = [r for r in rows if r.get("discarded")]

    print(f"{len(rows)} trials, {len(kept)} kept, {len(dropped)} discarded\n")
    if dropped:
        reasons = {}
        for r in dropped:
            reasons[r["discarded"]] = reasons.get(r["discarded"], 0) + 1
        for reason, count in sorted(reasons.items(), key=lambda kv: -kv[1]):
            print(f"  discarded x{count}: {reason}")
        print()

    by_condition: dict[str, list[dict]] = {}
    for r in kept:
        by_condition.setdefault(r["condition"], []).append(r)

    print(f"{'condition':<14}{'n':>3}  {'exp ready':<16}{'app baseline':<16}")
    print("-" * 52)
    for cond, rs in sorted(by_condition.items()):
        exp = [r["expReady"] for r in rs]
        total = rs[0]["expTotal"]
        app = [r["appReady"] for r in rs]
        exp_s = (f"{statistics.median(exp):.0f}/{total} ({min(exp)}-{max(exp)})"
                 if total else "—")
        app_s = f"{statistics.median(app):.0f} ({min(app)}-{max(app)})"
        warn = "  ⚠ n=1, not a result" if len(rs) == 1 else ""
        print(f"{cond:<14}{len(rs):>3}  {exp_s:<16}{app_s:<16}{warn}")

    controls = [r for r in kept if r["condition"] == "control"]
    if controls:
        series = [r["appReady"] for r in controls]
        print(f"\ncontrol baseline in run order: {series}")
        if len(series) >= 3 and (max(series) - min(series)) > 3:
            print("  ⚠ CONTROL DRIFTED by more than 3 — the pool changed during "
                  "this batch, so no condition in it is trustworthy.")
    else:
        print("\n⚠ no control trials — drift is unmeasured and the batch is "
              "uninterpretable. Always interleave `control`.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
