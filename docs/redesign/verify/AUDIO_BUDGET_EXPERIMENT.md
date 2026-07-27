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
