# Native voice-note playback — §4 verification

Run 2026-07-28 on a Mac Catalyst Debug build, against
`../PROMPT_NATIVE_AUDIO_PLAYBACK.md` §4. Driven by `--verify-audio`
(MainViewController), which unlocks from the DOM, opens the conversation by
accessible name, and clicks every note.

**Outcome: every check that can run unattended passes.** Three fresh launches,
same build:

| launch | notes | played | `<audio>` elements | resume |
| --- | --- | --- | --- | --- |
| 01:43:55 | 41 | **41** | **0** | pass |
| 01:45:59 | 41 | **41** | **0** | pass |
| 01:48:35 | 42 | **42** | **0** | pass |

Note counts differ because each `--verify-new-note` run sends one.

---

## The checks

**1. Every note plays, including past the old ~30 line and the tail.** 41/41,
then 42/42. Under the old `<audio>` path the same conversation played 30 and
stalled the rest at `networkState 2, readyState 0, error null`.

**2. A newly arrived note plays immediately, no reload, no re-unlock.**
`newNote: arrived=1 plays=true`. This is the original symptom — "old ones work,
new ones don't" — and it is the one that could not be tested without actually
producing a note, which is why `--verify-new-note` is a separate opt-in flag:
it sends a real voice note to whichever conversation is open.

**3. Any order, repeatedly, over several minutes, no degradation.** Each run
starts all 41 notes back to back, then runs the pause/switch/resume sequence on
top. Three launches spread over five minutes, all clean. Nothing here is
rationed — the ~30 cap was a WKWebView property and `AVAudioPlayer` never
touched it.

**4. Pause A → play B → return to A resumes.** Proven from the plugin's own log
rather than the probe's summary, because the DOM only shows a waveform:

```
[6707e3da] play   dur=2.964000 from=0.000000
[6707e3da] pause  at=1.061417
[3cf6b287] play   dur=2.041905 from=0.000000     <- B takes the player
[6707e3da] play   dur=2.964000 from=1.061417     <- A resumes, to the sample
```

The position round-trips exactly. B taking the player is also what forces the
bytes to be re-sent (`NEED_DATA`), so both branches of the resume protocol are
exercised in this one sequence — the earlier run, where B never played, resumed
via the data-less path and logged `resume at=` instead.

**5. Zero `<audio>` elements on this platform.** `audioEls: 0` on every census,
five seconds apart, for the whole run. The `src/components/debug/` scaffolding
was deleted first so this number could not be ambiguous.

**6. Interruption — NOT REPRODUCIBLE, and that is the correct behaviour.** Eight
system sounds were played through another process while the sweep ran. No
`AVAudioSession` interruption fired, the notes kept playing, and the audio
mixed. That follows from `.mixWithOthers`, which is load-bearing for a separate
reason (see `restorePlaybackSession` — dropping it killed WebView playback of
other notes) and must not be removed to make interruptions easier to observe.
The observer is wired and will pause cleanly for the interruptions that do fire
— a phone call, or another app taking the session exclusively — but that path is
**unverified on this platform**, and on a Mac it may never fire at all.

**7. Recording still works, and the session is left as the recorder expects.**

```
mic released? recorder=LIVE category=AVAudioSessionCategoryPlayAndRecord inputRunning=Optional(true)
finalized via=delegate bytes=72499 ms=2268 peakDb=-49.889065
mic released? recorder=nil  category=AVAudioSessionCategoryPlayback     inputRunning=Optional(false)
```

Recorded immediately after 41 notes had played, and the recording captured real
input (`peakDb=-49.9`, not the `-120` of digital silence). The microphone went
cold at the CoreAudio HAL, not merely at the API, and the session came back to
`.playback`.

## iOS

Re-verified 2026-07-28 on a real iPhone 14 Plus, after the component was split
into two backends — the `<audio>` branch was rewritten in the same commit, so
"iOS was unaffected by the bug" was no longer sufficient. A Debug build was
installed on the device and **Anmol confirmed voice notes play by hand**, which
is better evidence than the probe would have been. The gate reads
`isMacCatalystApp || isiOSAppOnMac`, both false there, so the element path is
what ran.

## What is NOT covered here

- **The interruption path**, per check 6.
- **A second device sending.** Check 2 was satisfied by producing a note on this
  device, which mounts after the page load in exactly the same way. A note
  arriving over the network is the same DOM event and a different source of it.

## Probe bugs worth remembering

The first run reported **39/41** and both failures were the probe's:

- `aria-label$="voice note"` also matches the composer's **"Record a voice
  note"** button. The probe clicked it, started a real recording, and then
  scored the note it could not pause as a playback failure.
- The played check ran 900ms after the click, and the shortest note in the
  conversation is **0.579s** — it had already finished. A successful play read
  as a failure.

Same build, 39/41 before the probe fixes and 41/41 after. The per-note log was
right both times while the aggregate was wrong twice over, which is the lesson
this bug has taught at every single stage: **tag the measurement with which note
it came from, and trust that over the summary.**
