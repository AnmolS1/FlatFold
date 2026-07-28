# Mac voice-note playback — findings since PROMPT_MAC_AUDIO_AUTOMATION.md

Everything below is measured on a signed Mac Catalyst build. This supersedes
`MAC_AUDIO_ROUND3_BRIEF.md` and the deleted round-2 docs, all of whose models
are refuted. Full trial-by-trial record: `verify/AUDIO_BUDGET_EXPERIMENT.md`;
raw rows in `verify/audio-trials.jsonl`.

**The question is answered.** What remains is a product decision, not a
diagnosis.

---

## 1. The model

> Media loaders are granted in a window tied to **page load**, capped at **~30**.
> They are **never reclaimed** within that page — not by unmounting the elements
> holding them, not by remounting the whole view. **A new page load reopens the
> window.**

Every measurement fits this and nothing contradicts it.

| observation | explanation |
| --- | --- |
| 30 of 40 notes load on first render | the ~30 cap |
| the last ~10 stall at `networkState 2`, `readyState 0`, `error` **null** | never granted; not an error |
| a newly ARRIVED note never plays | added after the window closed |
| **remount of the whole view → 0 of 40** | a remount is not a new page load, and the original 30 grants were not returned |
| **`webView.reload()` → 31 of 40** | a reload IS a new page load |
| the app's own error text, "Reopening the app clears it" | a relaunch is a new page load |

## 2. Refuted, with the evidence that killed each

Do not re-test these. Each cost at least one build/reproduce cycle, several cost
a night.

| hypothesis | killed by |
| --- | --- |
| element-count ceiling | 27 trials, five conditions, **0 added elements loaded** at app baselines from 8/40 to 38/40. At baseline 8 a ~30 ceiling leaves ~22 free slots. |
| capacity / resource pool | identical outcome at baseline 8 and at 38 |
| batch vs one-at-a-time | `batch10` and `click3` indistinguishable, both 0 |
| DOM containment | appending into the exact parent of working notes: 0 |
| provenance (imperative vs React) | a **clone of a working element** beside the original: 0. An element **React renders in its own commit**: 0. |
| "a view's first render" | remount → 0 of 40 |
| service worker | `swControlled=false` while notes stalled; SWs do not run on `capacitor://` in WKWebView |
| container / codec | `stco[0]` == `mdatPayload` exactly; `AVAudioFile` opens the file; old notes of the same MIME play |
| blob URL revoked early | instrumented: 16 CREATED, **0 REVOKED** |
| audio session category | a real asymmetry was found and fixed; it changed nothing about playback |
| the test fixture | a fresh element carrying a **real working note's URL** stalls identically |

Also refuted, and worth naming because they were shipped and reverted: **lazy
`src`** (`dd31836`) and **element-on-play** (`347944c`). Both made every load
late and made things strictly worse.

## 3. What a fix costs — the actual decision

A reload re-locks the keystore. That is deliberate (`STATUS.md`): the
Argon2-derived key lives only in the JS heap, so a reload drops it. "Reload to
fix audio" therefore means "ask for the password again".

Options, roughly in order of appeal:

1. **Reload on demand.** A "reload to play older notes" affordance on a note
   that will not play. The user chooses to pay the unlock, in the one moment
   they want the thing it buys.
2. **Reload at a natural boundary** — returning from a long background period,
   where a re-unlock is expected anyway.
3. **Spend the ~30 deliberately.** Render `<audio>` only for the most recent ~25
   notes so the grant covers what people actually play, and let older ones need
   a reload. Cheap, and independent of the reload work.
4. **Automatic reload on new-note arrival.** Rejected unless combined with
   biometric unlock — it turns every incoming voice note into a password prompt.

Face ID / Touch ID / passkey unlock all already exist and reduce the cost to a
gesture. On Mac Catalyst the biometric label now reads the device's real
biometry type rather than assuming Face ID.

## 4. Confidence, honestly

- The **model** is well supported: ~60 trials, five conditions, interleaved,
  with enforced cooldowns and auto-discard of unbaselined runs.
- The **reload result is n=1.** It is the one positive result in the whole
  investigation and it has not been replicated. `reload` should be a standard
  condition in the next batch alongside `control`.
- **Unknown:** whether repeated reloads keep working or degrade. If the pool is
  process-wide rather than page-wide, the second or third reload may return
  less. This matters a lot for option 4 and somewhat for option 1.
- **Untested input variable:** `convertFileSrc` (a `capacitor://` URL) instead
  of `blob:`. It is the one thing about the source never varied, and the
  recorder already uses that transport.

## 5. Scoping questions still open

- **Does this reproduce on real iOS?** Everything here is Catalyst. iOS is the
  shipped target. If iOS is unaffected, Catalyst is a known-degraded platform
  and macOS can ship with this documented. One build, one conversation, needs a
  real device (the simulator cannot reach a logged-in state).
- **Was it ever better?** `git bisect` against a conversation with 30+ notes
  would name a regression commit, if one exists.

## 6. Tooling built along the way

All committed, all reusable.

- `scripts/audio-trial.sh` — one trial, protocol enforced: a **cooldown gate**
  (the resource is reclaimed over minutes while a build-relaunch cycle is ~2
  minutes, so the natural rhythm of this work measures an exhausted pool), and
  **auto-discard of any trial without a baseline**.
- `scripts/audio-batch.sh` — interleaved, shuffled, control per rep.
- `scripts/audio-analyze.py` — median/range/n per condition; flags `n=1` as "not
  a result"; **voids the batch if the control series drifts**.
- `--audio-experiment=<condition>` — conditions are launch arguments, so one
  build runs them all. Today: `control`, `click3`, `batch10`, `container3`,
  `clone3`, `react3`, `remount`, `reload`, `fixture3`, `delayed3`.
- `src/components/debug/` — DEBUG-gated scaffolding: `ExperimentAudio` (React
  renders elements on request) and `useDebugRemountKey` (a probe can force a
  real remount). **Delete both once this is settled.**

### Traps that cost real time

- `NSLog` produces **nothing** from this target outside Xcode. Use `os.Logger`,
  and every interpolation needs `privacy: .public` or it logs `<private>`.
- `/usr/bin/log`, not `log` — the latter is shadowed in this zsh.
- **Rebuilding mid-batch** swaps the `.app` that in-flight trials launch,
  silently changing conditions inside one batch.
- **`sort -R` does not shuffle a list of repeated values** — it groups
  identical lines, producing a perfectly blocked plan that looks shuffled.
- **Screen coordinates are not a stable interface.** A batch once typed the test
  password into a video player because the window had moved.
- **Nothing else on the Mac should play media during a batch** — the pool is
  system-wide, and a video playing contaminated an entire overnight run.

## 7. Process note

Six models were held confidently and killed by measurement: pipeline
exhaustion, element-count ceiling, late creation, containment, provenance, and
"a view's first render". Two fixes were shipped and reverted on the strength of
them.

What broke the deadlock, in order of value: **tagging every log line with which
note it came from** (the stalled note reports *no error*, while other notes are
evicted and report `code=4` — so the visible error belongs to a different note
than the broken one); **enforcing a cooldown** in code rather than in
discipline; and **auto-discarding trials without a baseline**, which caught a
whole batch driving the wrong window.

`BUILD SUCCEEDED` and 718 green tests said nothing about any of this. Every real
finding came from the running app.
