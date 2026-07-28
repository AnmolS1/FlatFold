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

---

# Round 4 — the first batch with real n. The count ceiling is dead.

2026-07-27, 15 planned trials, interleaved, 15-minute enforced cooldown, probe
unlocking from the DOM. 42 rows on file, 19 kept, 23 discarded for no baseline.

## MEASURED — every added element failed, at every level of headroom

| condition | app baseline | added loaded |
| --- | --- | --- |
| click3 | 8/40 | **0/3** |
| click3 | 12/40 | **0/3** |
| batch10 | 15/40 | **0/10** |
| batch10 | 17/40 | **0/10** |
| batch10 | 27/40 | 0/10 |
| batch10 | 29/40 | 0/10 |
| click3 | 29/40 | 0/3 |
| click3 | 30/40 | 0/3 |
| click3 | 31/40 | 0/3 |
| click3 | 31/40 | 0/3 |
| batch10 | 38/40 | 0/10 |
| batch10 | 38/40 | 0/10 |

Medians: `click3` 0/3 (range 0–0, n=6), `batch10` 0/10 (range 0–0, n=6),
`control` baseline 29 (n=7).

## THE COUNT-CEILING MODEL IS REFUTED, this time properly

The earlier refutation rested on one uncooled run and was itself suspect. This
does not:

- With a baseline of **8 of 40**, a ceiling anywhere near 31 leaves ~20 free
  slots. Three added elements still loaded **zero**.
- The result is identical at baseline 38, where a ceiling model predicts
  starvation, and at baseline 8, where it predicts success.
- 12 trials, two conditions, zero variance.

**Control drift does not weaken this — it strengthens it.** The control series
(29, 31, 15, 29, 29, 30, 30) drifted enough that the analyzer voids the batch
for comparing conditions to each other, and that verdict stands for any
between-condition claim. But the finding here is *within* trials: at every one
of a 4.75x range of pool availability, added elements loaded 0. Drift varied
the thing a ceiling model says should matter, and the outcome never moved.

`batch10` vs `click3` also shows no difference, so **batch is not the variable
either**.

## What survives

The discriminator is not how many elements exist, and not when the load starts
in wall-clock terms. It is **how the element came to be**: elements React
creates during a render/commit load; elements added afterwards with
`document.createElement` + `appendChild` never do, however much capacity exists.

## UNCONTROLLED VARIABLE — name it before building on this

The probe appends to `document.body`. The app's own elements live **inside the
React tree**, within the scrolling message container. That difference has never
been isolated, and it is at least as plausible as "React vs imperative":

1. append into the message container instead of `document.body`
2. have REACT render an extra element (a debug component), not the probe
3. take an element the app already rendered, clone it, and insert the clone

If (1) loads, the answer is DOM position/containment, not provenance — and the
whole framing changes again. Run those three before any fix.

## Harness note

23 of 42 rows discarded for no baseline, so the DOM unlock still fails roughly
half the time. It fails SAFELY — discarded, not silently wrong — but it halves
throughput and should be made reliable before the next batch.

---

# Round 5 — five conditions, 27 trials, one answer

| condition | n | added loaded | app baseline |
| --- | --- | --- | --- |
| `click3` (append to body) | 10 | **0/3** (0–0) | 30 (8–31) |
| `batch10` (10 at once) | 6 | **0/10** (0–0) | 28 (15–38) |
| `container3` (into the notes' own parent) | 4 | **0/3** (0–0) | 30 (29–31) |
| `clone3` (clone a WORKING element, same parent) | 4 | **0/3** (0–0) | 30 (15–31) |
| `react3` (rendered by REACT, in a commit) | 3 | **0/3** (0–0) | 30 (30–31) |
| `control` | 10 | — | 29 (15–31) |

Zero variance. Not one added element loaded in 27 trials, while the app's own
~30 loaded in every one of them.

## Everything proposed so far is refuted

- **not count** — 3 and 10 behave identically, and both fail at baseline 8 where
  a ~30 ceiling leaves ~22 free slots
- **not capacity** — identical outcome across baselines 8 to 38
- **not containment** — appending into the exact parent of the app's working
  notes changes nothing
- **not provenance** — a CLONE of a working element, inserted beside the
  original, fails; and so does an element React renders in its own commit
- **not batch** — no difference between one-at-a-time and ten-at-once

The control drift warning voids BETWEEN-condition comparisons and that verdict
stands. It does not touch this finding: every condition is 0, so there is
nothing to compare, and the result holds across a 4.75x range of the very
quantity drift varies.

## MODEL — the one thing left, and it fits every measurement

> A media element is granted a loader only if it exists when the conversation
> view FIRST RENDERS. Elements added to an already-mounted view never get one,
> regardless of how they are created, where they are placed, or how much
> capacity is free. Separately, that initial grant is itself capped at ~30.

Two effects, not one, which is why single models kept failing:

| observation | which effect |
| --- | --- |
| ~30 of 40 load, last ~10 stall | the ~30 cap on the initial grant |
| a newly ARRIVED note never plays | added after initial render |
| every experimental condition loads 0 | added after initial render |
| withholding `src` from all 40 broke everything (`dd31836`) | made every load late |
| creating on the play gesture broke everything (`347944c`) | made every load late |

## The fix this implies — and the one experiment that would confirm it

If the model holds, **re-mounting the conversation view should rescue stalled
notes**, because they then exist at a fresh initial render.

`MAC_AUDIO_ROUND3_BRIEF.md` §7 says explicitly *"do not ship a workaround that
re-mounts the list"* — on the grounds that a re-mounted element is still a late
load. Under this model that reasoning is wrong: a remount IS a new initial
render. That instruction should be treated as superseded, but only after the
experiment below, not before.

**Next condition to build: `remount`.** Force the conversation view to unmount
and re-render, then measure whether the previously-stalled tail loads. If it
does, the fix is a remount on new-note arrival plus keeping the visible note
count under the ~30 grant. If it does not, the model is wrong and the "initial
render" framing needs re-deriving.

## Harness

24 of 61 rows discarded, still ~40%, almost all "app rendered no notes" — the
DOM unlock remains flaky. It fails safely, but fixing it would roughly double
throughput.

---

# Round 6 — remount REFUTES the initial-render model too

`remount` now genuinely works, via a DEBUG hook the app exposes
(`useDebugRemountKey`, bumping a `key` on `<Chat />`). `midEls=0` proves the
subtree was torn down — the three earlier triggers never achieved that and
their before==after numbers were meaningless.

    before=30/40   after=0/40   midEls=0

A fresh mount of the conversation view, rendering all 40 notes again from
scratch, granted **zero** loaders — where the very same view granted 30 on the
first mount of that page.

## So the grant is per PAGE LOAD, and is never returned

| observation | fits |
| --- | --- |
| first conversation render: 30 of 40 | ~30 grants available per page load |
| every added element, every variant: 0 | the window has closed |
| remount, 40 fresh elements: 0 | closed, and unmounting the original 30 did NOT return anything |
| `347944c` (element on play, 0 rendered at mount): 0 | closed by then, even though nothing had spent the budget |
| "reopening the app clears it" (the app's own error text) | a relaunch is a new page load |

Two properties, both now measured:
1. **Grants happen only during an early window** tied to page load, not to view
   mount. A remount is not a new window.
2. **Grants are never reclaimed within a page.** Tearing down the 30 elements
   holding them freed nothing for the 40 that replaced them.

Note this kills the reading in round 5 that a *view's* first render is what
matters. It is the PAGE's.

## What this means for a fix

Bleak, and worth stating plainly: **a note that is not present during the early
window after page load can probably never be played in that session.** That is
consistent with every user report — new notes never play until the app is
relaunched.

Directions that follow from the model, none tested:
- spend the ~30 on the notes most likely to be played (the most recent), and
  accept that older ones need a relaunch — a product decision, not just a fix
- find whether the window can be reopened or extended at all (a WKWebView
  reload? a new WKWebView?), which is the only route to a real fix
- `convertFileSrc` instead of `blob:` remains untested on the app page and is
  the one input variable never varied

## Do not

Re-try lazy `src`, element-on-play, singleton players, element-count caps,
containment, cloning, or React-rendered elements. All measured, all zero.
