# Claude Code — automate the audio experiment (and the model that reconciles round 3)

Answer to `MAC_AUDIO_ROUND3_BRIEF.md`. Two parts: a synthesis that says the two "refuted" models are probably both partly right, and a spec for the unattended harness that would have prevented three rounds of void results.

---

## Part 1 — The models are not rivals. The pool is system-wide and slowly reclaimed.

The brief's §1 is the most important measurement in this whole investigation, and it may also be the answer rather than just a protocol note:

```
launch 1 (post-reboot)   28/39      identical code throughout
launch 2 (~90 s later)    0/39
launch 3 (~5 min later)  28/39
launch 4                 29/39
```

**A resource that survives process exit and returns over minutes is not per-page and not per-process. It is system-wide** — an AVFoundation/`mediaserverd`-level pool, outside the app entirely.

Take that seriously and the contradiction in §2 dissolves. One model fits every number on the table:

> There is a finite, **system-wide** pool of media loaders. Each element that begins a load takes one. They are returned **slowly** (minutes), and not promptly on element teardown or process exit.

| observation | explained |
| --- | --- |
| 39 together on a fresh pool → 28 load | ~28 slots were available; the rest starved |
| 3 on click, 4.5 min after a 39-element run → **0** load | the pool was still drained by the previous run's 39. Not "late creation fails" — *no slots existed* |
| launch 2 at 90 s → 0/39 | pool still exhausted from launch 1 |
| launch 3 at ~5 min → 28/39 | recovered |
| swapping `src` on a loaded element drops it (`ready=1 net=1` → `ready=0 net=2`) | the swap releases its slot and must immediately re-acquire; on a drained pool the re-acquire starves. **This is the cleanest evidence for the model** |
| the "late load never completes" result | every late-load test ran on a pool drained by the run that preceded it |
| the standalone harness page loading nothing | same — it was always opened after a run that had drained the pool |

So: **the count-ceiling model was never refuted; it was measured on a contaminated pool.** The brief's own §2 caveat suspects exactly this, and I think it is right. Experiment §4.1 (re-run 3-on-click after a 15-minute wait) is the highest-value single run available, and if 3 elements load fine, `347944c`'s bounded-element-count approach comes back as the fix — with one addition the earlier version lacked: **because release is slow, the app must not churn elements.** Acquire few, hold them, never swap `src` on a live element.

I am stating this as a model, not a fact. It is falsifiable: if a 15-minute-cooled run of 3 elements still loads 0, the model is dead and the pool is not what gates this.

**Corollary that matters for the product:** if the pool is genuinely system-wide, another app playing media can starve FlatFold, and FlatFold can starve itself across launches. Any fix must be conservative in absolute terms, not merely "under the ceiling we measured once."

---

## Part 2 — The automation, and why it is the actual bottleneck

Every wrong conclusion in this saga came from the same three causes, none of which are about intelligence:

1. **n = 1.** Single runs treated as results.
2. **No enforced cooldown.** The natural build-relaunch rhythm (~2 min) is shorter than the reclaim time (~5 min), so the default rhythm measures an exhausted pool.
3. **Rebuilding between conditions**, which makes each condition expensive and encourages running one of each instead of many.

All three are mechanically fixable. Build this before running another experiment by hand.

### 2.1 Decouple the experiment from the build — the biggest win

Today the probe JS is edited inside `MainViewController.runAudioExperiment`, so **every condition costs a rebuild**. Change it so one build can run every condition:

- The runner writes a small JSON file (condition name + parameters) to a path the app reads at launch, or passes it as a launch argument (`--audio-experiment=batch10 --trial=7`).
- `runAudioExperiment` dispatches on that value to one of the condition functions.
- **One build, then N trials with no rebuild.** A trial becomes `cooldown → launch → measure → quit`, and the cooldown dominates instead of the build.

### 2.2 Enforce the protocol in code, not in discipline

- **Cooldown gate:** the runner records the timestamp of the last quit and refuses to launch until `COOLDOWN` (default 15 min, configurable) has elapsed. This is the single most important line of the harness.
- **Baseline in every trial:** every run reports the app's own `appReady=N/M` alongside the condition result. **A trial without a baseline is discarded automatically** — make that the runner's rule, not a human's.
- **Control trials:** every batch includes plain `--audio-experiment=control` runs (app baseline only, no extra elements) interleaved with the real conditions. If the control drifts across a batch, the batch is void. This detects pool drift, thermal state, and anything else you have not thought of.

### 2.3 Design the batch properly

- **Repeat each condition ≥5 times.** Report median and range, never a single number.
- **Interleave, don't block.** Randomize condition order within the batch (`A B control C A control B C …`), so a slow drift in pool availability cannot masquerade as a condition effect. Running all of A then all of B is how you get a confident wrong answer.
- **One variable per condition.** The conditions from brief §4 map directly: `click3`, `batch10`, `reinsert`, `timeout2s` vs `sync`, `convertFileSrc` vs `blob`, plus `control`.
- At 15-minute cooldowns a batch of 30 trials is ~8 hours — i.e. **one overnight run replaces a week of hand-testing**, which is the whole argument for building this.

### 2.4 Structured output, not log soup

Have the probe emit **one JSON line** with a stable marker, e.g.:

```
FLATFOLD_EXP {"trial":7,"condition":"batch10","appReady":28,"appTotal":39,
              "expReady":6,"expTotal":10,"readyMask":"1101110100",
              "netMask":"1131112122","errors":[],"msSinceLastQuit":903000}
```

The runner harvests with `/usr/bin/log show --style json --predicate 'subsystem == "dev.flatfold"'`, greps the marker, appends to `docs/redesign/verify/audio-trials.jsonl`, and a small analysis script prints a table of condition → median ready, range, n. Then the finding is a distribution you can point at, not a census string read by eye.

### 2.5 Runner skeleton

```bash
#!/usr/bin/env bash
# scripts/audio-trial.sh <condition> <trial-n>   — one trial, protocol enforced
set -euo pipefail
COOLDOWN=${COOLDOWN:-900}   # seconds; the reclaim window, generously
STAMP=.audio-last-quit

if [ -f "$STAMP" ]; then
  elapsed=$(( $(date +%s) - $(cat "$STAMP") ))
  if [ "$elapsed" -lt "$COOLDOWN" ]; then sleep $(( COOLDOWN - elapsed )); fi
fi

osascript -e 'quit app "App"' 2>/dev/null || true
sleep 3
open -n build/DDcat/Build/Products/Debug-maccatalyst/App.app \
  --args --audio-experiment="$1" --trial="$2"
sleep 75                     # launch + unlock + 10s census cycles
/usr/bin/log show --last 2m --info --debug --style json \
  --predicate 'subsystem == "dev.flatfold"' \
  | grep -o 'FLATFOLD_EXP {.*}' | sed 's/^FLATFOLD_EXP //' \
  >> docs/redesign/verify/audio-trials.jsonl
osascript -e 'quit app "App"'
date +%s > "$STAMP"
```

Then a `run-batch.sh` that takes a condition list, shuffles it with repeats, and loops. Unlock is already scripted per brief §6 — keep the credential read from `.env` at run time, never echoed, never committed.

### 2.6 What automation does not fix

Be clear-eyed: this does not identify the mechanism. It removes contamination and turns anecdotes into distributions so the mechanism becomes visible. It also cannot fully rule out a system-wide confound from *other* apps holding media resources — so log whether anything else is playing, and prefer an otherwise-idle machine for a batch.

---

## Part 3 — Suggested order

1. **Build the harness** (§2.1–2.5). One build, parameterized conditions, enforced cooldown, JSONL output. This is a couple of hours and it pays for itself in the first batch.
2. **Run the decisive batch overnight:** `control`, `click3`, `batch10`, ×5 each, interleaved, 15-minute cooldowns. That single batch resolves the §2 contrast — whether the variable is *batch* or *timing* — with real n.
3. **If `click3` loads fine on a cooled pool**, the count model stands: reinstate a bounded-element approach (`347944c`'s shape), plus the "never swap `src` on a live element, never churn" rule from Part 1.
4. **If it still loads 0 on a cooled pool**, my Part 1 model is dead — report it and I will re-derive rather than guess.
5. Only then the remaining conditions (`reinsert`, activation, `convertFileSrc`), and the two scoping questions in brief §5 (does it reproduce on real iOS; does `git bisect` name a regression commit). **The iOS question is worth pulling forward** — it is one build, and if iOS is unaffected then Catalyst is a known-degraded platform and macOS can ship while this continues.

## Constraints

Unchanged: frozen paths (`src/crypto/**`, `src/keystore/**`, `worker/**`, the ratchet region), public repo so no secrets in commits, voice-note temp files are plaintext audio of E2EE messages and must never be logged by content, commit by explicit path, `os.Logger` with `privacy: .public`, `/usr/bin/log`. The harness scripts and `audio-trials.jsonl` are fine to commit; the `.audio-last-quit` stamp and anything reading `.env` are not.
