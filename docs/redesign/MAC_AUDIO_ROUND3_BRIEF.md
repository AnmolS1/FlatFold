# Mac voice notes — round 3 brief: one contrast, and how to break it open

For Fable. Supersedes the diagnosis in `MAC_AUDIO_ROUND2.md` (§2's service-worker
suspect is **exonerated**, §1's late-load model is **refuted**). Full numbers in
`verify/AUDIO_BUDGET_EXPERIMENT.md`.

**Read §1 (the protocol) before running anything.** Getting it wrong invalidated
two entire rounds of work, including most of my own conclusions.

---

## 1. The measurement protocol — non-negotiable

The media resource is reclaimed when the process exits, **but over minutes**:

```
launch 1 (post-reboot)     28/39 load
launch 2 (~90 s later)      0/39
launch 3 (~5 min later)    28/39
launch 4                   29/39     ← identical code throughout
```

A rebuild-and-relaunch cycle is ~2 minutes. So **the default rhythm of this work
measures an exhausted pool**, and an exhausted pool produces total failure that
is indistinguishable from every hypothesis on the table. "Nothing loads at all",
"there is no ceiling", and "late loads never complete" were all artifacts of it.

- **Wait 4–5 minutes minimum after quitting before measuring.** Longer if the
  previous run created many elements.
- Every run must report the app's own baseline (`appReady=N/M`) alongside its
  result. A run without a baseline cannot be interpreted and should be discarded.
- A reboot is **not** required. Waiting is.

## 2. THE CONTRAST — this is the whole brief

Same component, same page, same session, same blob provenance, same
`preload="metadata"`, both attached in JSX by React:

> **39 elements created together when a conversation renders → 28 load.**
> **3 elements created one at a time, on click, → 0 load.**

Whatever differs between those two situations is the mechanism. Everything else
below exists to stop you re-deriving what is already known.

### Both models are refuted — do not build on either

| model | explains | refuted by |
| --- | --- | --- |
| **count ceiling ~28–31** | the 28/39 split; the dead tail of a long conversation | 3 elements on a fresh pool → 0 loaded. A ceiling of 31 cannot explain 0 of 3. |
| **late creation never loads** | the 0/3; newly arrived notes never playing | the app's own notes are created by React when a conversation is OPENED — long after page load — and 28 of them load |

Each explains what the other cannot. Two implementations have now been built and
reverted on the strength of one of them.

### ⚠️ One caveat on the 0-of-3 result, stated because it matters

That run waited **~4.5 minutes** after the previous launch quit. Launch 3 needed
**~5 minutes** to recover. So the 0-of-3 is *inside the noise band of the
reclaim timing* and may itself be another exhausted-pool artifact.

**Re-run it first, after a 15-minute wait or a reboot.** If 3 elements then load
fine, the count model is back and the fix is simply to bound element count —
which is `347944c`, already written and reverted. Do this before anything else
in §4; it is one run and it could end the investigation.

## 3. Ruled out — each cost at least one build/reproduce cycle

| hypothesis | how it died |
| --- | --- |
| service worker | `swControlled=false` while notes stalled. SWs do not run on `capacitor://` in WKWebView at all. A `--no-sw` launch flag exists to re-confirm. |
| my test fixture | a fresh element carrying a REAL working note's blob URL stalls identically |
| container / codec | `stco[0]` == `mdatPayload` exactly; `AVAudioFile` opens it; old notes of the same MIME play |
| blob URL revoked early | instrumented: 16 CREATED, **0 REVOKED** |
| audio session category | real asymmetry found and fixed; changed nothing about playback |
| `preload` none vs metadata, explicit `load()` | no effect |
| Web Audio decode pool | `active:0 waiting:0` while notes stall; its failure on Mac is pre-existing and cosmetic |
| detached vs attached | inverted twice under contamination; untrustworthy, and the app's elements are attached anyway |

Also measured, unexplained, possibly the same mechanism: **swapping `src` on an
element that HAS a pipeline drops it** — `ready=1 net=1` → `ready=0 net=2`. That
is why a singleton player cannot be assumed to work.

## 4. Experiments that would discriminate

Ordered by how much they'd narrow it. Each needs the §1 protocol.

1. **Re-run 3-elements-on-click after a 15-min wait.** See the caveat above.
2. **Batch vs timing.** On one click, create **10** elements at once. If several
   load, the variable is *batch*, not *when* — and the fix is to create a note's
   element alongside others rather than alone. This single test separates the two
   refuted models.
3. **Which 28 win?** Are they the first 28 in document order, the visible ones, or
   the first to request? The census string shows failures at indices 0, 11, 21,
   28 and 32–38 — mostly a tail, but not purely. If it is document order, that is
   a granted-in-order budget; if it is visibility, it is a viewport heuristic.
4. **Re-insert an existing working element.** Remove a loaded element from the DOM
   and re-append it. Does it keep its pipeline? Distinguishes "element identity
   holds the resource" from "insertion order does".
5. **Activation.** Create an element from a `setTimeout` 2 s after a click (no
   activation) vs synchronously in the handler. If they differ, user activation
   is implicated — which would be surprising and important.
6. **`convertFileSrc` instead of `blob:`** on the app page. Still untested there;
   the recorder already uses that transport. If a `capacitor://` media URL loads
   where a `blob:` does not, that is both answer and fix.

## 5. Scoping questions, still open and both cheap

- **Does this reproduce on real iOS?** Everything measured is Catalyst. iOS is the
  shipped target. If iOS is fine, Catalyst is a known-degraded platform and macOS
  can ship without solving this.
- **Did it regress at a specific commit?** `git bisect` against a conversation
  with 30+ notes would name it, if it was ever better.

## 6. Tooling that now exists

- `--audio-experiment` — runs a JS probe **in the app's own page**
  (`MainViewController.runAudioExperiment`). Edit the JS there per experiment.
  A standalone harness page does **not** work: it reproduces none of the app's
  behaviour, and three versions of one produced entirely void numbers.
- `--no-sw` — service worker provably absent.
- 10 s census: per-element `readyState`/`networkState`/`error` + decode pool.
- Per-note tagged logs (`[abc123] …`). **Keep them.** Two rounds were lost
  reading `code=4` as the broken note's error when it belonged to other notes —
  the stalled note reports *no error at all*.
- Unattended runs: unlock is scripted (System Events; credential read from `.env`
  at run time, never echoed, never committed).

Read with: `/usr/bin/log show --last 4m --info --debug --predicate 'subsystem == "dev.flatfold"' --style compact`

Two traps: `NSLog` produces **nothing** from this target outside Xcode — use
`os.Logger`; and `Logger` redacts to `<private>` without `privacy: .public`.

## 7. State of the app

`src` at mount (`45d4429`): **28–29 of 39 notes play**, the tail does not. Both
attempted fixes were tested and reverted. Recording, sending, the microphone and
the biometric label are all working and verified on Catalyst.
