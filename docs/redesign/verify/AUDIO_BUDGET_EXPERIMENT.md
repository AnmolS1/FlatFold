# Audio budget experiment — results

Run 2026-07-27 on a signed Mac Catalyst build, per
`../PROMPT_MAC_AUDIO_FIX.md` Phase 1.

**Outcome: the decision table's "stop and report" row fired. Phase 2 (the
singleton player) was NOT implemented, and must not be until the model below is
resolved — the same measurement that kills the element-budget diagnosis also
kills the singleton design.**

---

## MEASURED — the result that decides it

Run **inside the app's own page**, with a real conversation open, adding
`<audio>` elements programmatically (blob URL, `src` set before insertion,
matching what React does):

```
+1  total=1  ready=0 stuck=1
+4  total=5  ready=0 stuck=5
+5  total=10 ready=0 stuck=10
+10 total=20 ready=0 stuck=20
+20 total=40 ready=0 stuck=40
+40 total=80 ready=0 stuck=80
```

`error` is null throughout; every element sits at `networkState 2`,
`readyState 0`, indefinitely.

**A single programmatically-created media element never loads — not one, not
eighty.** There is no ceiling to find. The "31 of 37" census that motivated the
element-budget theory was never a budget.

## MEASURED — what actually distinguishes a working element

The 31 elements that DO reach `readyState 1` are created by React **during
render**. Elements created **later, imperatively**, never load, at any count.

This resurrects the finding recorded in `594e7e5` ("a late load never
completes") which was subsequently, and wrongly, retracted in `347944c`.

## Consequences

- **The element-budget diagnosis is refuted.** `LIVE_NOTE_LIMIT` rations a
  resource that is not the constraint.
- **The singleton player (Phase 2) is refuted by the same data.** It swaps `src`
  on one long-lived element — a late load by construction — which is exactly
  what never completes. `E3`/`singleton` was run and returned `played=0/40`,
  failing at `i=0` with `timeout ready=0 net=2 err=-`. Per the prompt's own
  decision table, that is the "stop, do not implement" row.
- **`347944c` was wrong and has been reverted** (`VoiceNote.tsx` and its test
  restored to `594e7e5`). It created the element on the play gesture — always
  late — so it could never have worked. Reverting restores the state where
  notes present at initial render play.

## MEASURED — the harness was broken, and how that was caught

Three harness versions produced void numbers before this was noticed. Recorded
because the failure mode is more instructive than the numbers:

| version | design | result | why it was void |
| --- | --- | --- | --- |
| v1 | all experiments in one standalone page, on load | `E4` detached loaded, everything after stalled | no teardown between tests; the first element held the resource, so "n=5 all stuck" and "budget is 1" are indistinguishable. `E3` deadlocked on an unbounded `await play()` and reported nothing. |
| v2 | one test per PROCESS | all three orderings stalled | no user gesture anywhere in the page |
| v3 | one click drives everything, control test first and last | every test stalled, including `control(first)` | still a standalone page |
| v4 | validate the harness itself | direct URL, typed blob AND untyped blob ALL stalled | **the page was the problem, not the fixture or blobs** |

v4 is the one that mattered: on the standalone harness page **nothing loads at
all**, while the app's page loads 31 in the same WebView. A harness that cannot
reproduce the working baseline cannot measure a deviation from it. Everything
v1–v3 reported is void.

The experiment was then re-run by injecting into the app's real page, which
keeps the origin, CSP, bridge and whatever else `index.html` establishes, so the
only variable is the one under test. That is the run reported at the top.

**UNVERIFIED, and the next thing to find out: why does a standalone page at the
same origin, in the same WebView, load no media at all?** Whatever the answer,
it is likely the same mechanism that stops late elements loading in the app
page.

## Not answered

- `E2` (system contention) — never reached; the ceiling it probes does not exist.
- `E5` (hidden vs visible) — both stalled on the standalone page, so this is
  still open. `className="hidden"` remains untested in a page where media works.
- `E6` (does teardown return budget) — moot without a budget.

## Where this leaves the app

- Restored to `src`-at-mount: notes present at initial render play; notes that
  arrive later do not. That is the pre-existing bug, unfixed but not worsened.
- The real question is now much sharper: **why does a media load initiated after
  initial render never complete in this WebView?** Not "how many elements fit".

Directions worth research, none tested:
1. Is this WKWebView refusing media loads outside the initial document load —
   an app-bound-domain, autoplay-policy, or `WKURLSchemeHandler` interaction?
2. Does serving notes through `convertFileSrc` (a `capacitor://` URL, which the
   recorder already uses to read temp files) behave differently from `blob:`?
   Note v4 measured a DIRECT custom-scheme URL failing too — but on the broken
   standalone page, so that is not yet evidence about the app page.
3. Does the same failure reproduce on iOS, or is it Catalyst-only? Everything
   here is Catalyst.

## Reproducing

Launch with `--audio-experiment`; `MainViewController.runAudioExperiment` runs
it in the app page ~12s after launch. Read with:

```bash
/usr/bin/log show --last 4m --info --debug \
  --predicate 'subsystem == "dev.flatfold"' --style compact
```

The standalone harness page is deliberately NOT committed — it measured nothing
and keeping it invites re-running it.

---

# Round 3 — after a reboot. Both models fail.

Run 2026-07-27 01:13–01:50, post-reboot, with per-test process isolation and a
wait for resource reclamation between runs.

## MEASURED

| what | result |
| --- | --- |
| 39 notes, `src` at mount, launch 1 after reboot | **28 of 39 load**; the rest stall `net=2`, `error` null |
| same, launch 2, ~90 s after quitting launch 1 | **0 of 39** |
| same, launch 3, ~5 min after quitting launch 2 | **28 of 39** |
| same, launch 4 | **29 of 39** |
| fresh element given a REAL working note's blob URL, while 29 loaded | stalls |
| my generated fixture, same conditions | stalls (so the fixture is NOT at fault) |
| element that HAD a pipeline, repointed at a stalled note's URL | `ready=1 net=1` → **`ready=0 net=2`** |
| **element-on-play fix, fresh pool, only 3 elements ever created** | **0 of 3 load** |

## What this settles

- **The resource is reclaimed on process exit, but over MINUTES, not instantly.**
  The 0/39 at launch 2 was a still-occupied pool, not a permanent leak, and not
  a code change. No reboot is required — waiting is.
- **This confound invalidated most of round 2.** Rebuild-and-relaunch cycles are
  ~2 minutes, so nearly every measurement that night was taken against a pool
  the previous launch still held. That is where "nothing loads at all", "there
  is no ceiling", and "late loads never complete" all came from.
- **The fixture is exonerated.** A fresh element carrying a URL that another
  element had provably loaded stalls identically.

## What this does NOT settle — both models are now refuted

**Count model** (a ceiling of ~28–31 elements): refuted by the last row. With a
fresh pool and only THREE elements ever created, none loaded. A ceiling of 31
cannot explain 0 of 3.

**Late-creation model** (loads started after initial render never complete):
refuted by the fact that the app's own notes are created by React when the
conversation is opened — long after page load — and 28 of them load fine.

Each model explains the measurements the other cannot, and neither explains all
of them. **Do not build on either until something explains both.** Two rounds
have now been spent implementing a model that later measurement destroyed.

The sharpest remaining contrast, and where the next attempt should start:

> 39 elements created together, when a conversation renders → 28 load.
> 3 elements created one at a time, on click, in the same app → 0 load.

Same component, same page, same session, same blob provenance. Whatever differs
between those two situations IS the mechanism.

## Where the app is left

`src` at mount (unchanged, `45d4429`): ~28–29 of 39 notes play, the tail does
not. The element-on-play fix was tested against a fresh pool and made it worse
(0 of 3), so it stays reverted.

## Method notes

- Wait **4–5 minutes** after quitting before measuring, or the previous launch's
  resources are still held and every result is void.
- Automate unlock rather than relaunching by hand; the gate blocks the chat and
  therefore all media. A password-typing script (System Events, credential read
  from `.env` at run time, never echoed) made unattended runs possible.
- Never full-screen screenshot this machine while testing — an editor had a live
  credential on screen. Capture the app window region only.
