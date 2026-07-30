# Claude Code — play voice notes natively on Mac (stop fighting the web view)

Follows `MAC_AUDIO_FINDINGS.md`. The diagnosis there is accepted: media loaders are granted in a window tied to page load, capped ~30, never reclaimed within the page. **No workaround inside the web view can fix that**, because the constraint is the web view. So don't work around it — move playback out of the web view, exactly as recording already was.

**Do not implement the §3 reload options.** All four degrade the product (they trade a voice note for a password prompt), and they become unnecessary under this design.

---

## 1. Why this is the right fix, not another workaround

The precedent is already in this repo. `navigator.mediaDevices` is absent on Catalyst, so recording was moved into `FlatFoldAudioPlugin.swift` with `AVAudioRecorder`. That worked, and recording is verified working on Catalyst today.

**Playback is the same class of problem and takes the same solution.** The `<audio>` element is a web-view capability that is broken on this platform. `AVAudioPlayer` is not. The plugin, the Capacitor registration, the permission plumbing, the `os.Logger` instrumentation, and the JS wrapper (`src/lib/nativeAudio.ts`) all already exist — this adds methods to a proven file rather than introducing architecture.

What it removes, permanently, on the affected platform:
- the ~30 loader cap and the dead tail of long conversations
- newly arrived notes never playing
- `src`-swap dropping a live element
- any need to reload the page, and therefore any re-unlock cost
- the debug scaffolding in `src/components/debug/` and the `--audio-experiment` conditions (delete once this lands)

**A from-scratch native macOS app is the wrong scope** — that would mean reimplementing X3DH, the Double Ratchet, sender keys, the keystore, and recovery in Swift, tripling the security-critical surface and creating protocol drift between platforms. The right granularity is one capability, which is what this is.

## 2. Scope this first (one build, ~30 min)

**Does the ~30 cap reproduce on real iOS?** Everything measured is Catalyst; iOS is the shipped target and needs a real device (the simulator can't reach a logged-in state).

- **iOS unaffected** → gate native playback to Mac Catalyst only; iOS and web keep `<audio>`.
- **iOS affected too** → gate to all native platforms. Same code either way.

Answer this before building so the gate is decided by evidence.

## 3. Design

### 3.1 Swift — extend `FlatFoldAudioPlugin`

Use **`AVAudioPlayer(data:)`**, not `AVPlayer`. It takes bytes in memory, gives you `duration`, `currentTime`, and simple transport.

**This is a privacy improvement, and it is load-bearing:** decrypted voice-note audio is plaintext of an E2EE message. Playing from `Data` means it never touches disk at all — strictly better than the recorder's temp-file path, and it satisfies the standing constraint that plaintext must not be written somewhere readable.

Methods to add:

| method | notes |
| --- | --- |
| `playNote({ noteId, dataBase64, positionSeconds? })` | stop any current player, construct `AVAudioPlayer(data:)`, seek to `positionSeconds`, play. One player instance at a time — a chat plays one note at a time, which is the natural design here, and unlike the web view there is no cap to ration. |
| `pauseNote()` | pause, return `currentTime` |
| `seekNote({ seconds })` | |
| `stopNote()` | tear down the player |
| `getPlaybackState()` | `{ noteId, playing, currentTime, duration }` for resync |

Events back over the bridge via `notifyListeners`:
- `audioProgress` `{ noteId, currentTime, duration }` on a ~10 Hz timer while playing (cheap, and it drives the waveform cursor)
- `audioEnded` `{ noteId }`
- `audioInterrupted` `{ noteId, currentTime }` — handle `AVAudioSession` interruption notifications (a call, another app taking the session) and pause cleanly

Session handling: set category `.playback` for playback and **restore whatever the recorder expects afterwards**. The findings note a real session asymmetry was already found and fixed here — don't reintroduce it. Keep every log line `os.Logger` with `privacy: .public`, and keep the per-note tags (`[abc123] …`); they are what made this bug tractable.

### 3.2 JS — extend `src/lib/nativeAudio.ts` and add a small player store

- Wrap the new plugin methods, base64-encoding the decrypted bytes for the bridge (a voice note is small; 33% base64 inflation on ~75 KB is irrelevant).
- A `voicePlayer` store subscribing to the plugin's events and exposing `{ noteId, playing, currentTime, duration }` — same shape as the singleton store from the earlier round, but backed by Swift instead of an `<audio>` element, so it isn't subject to the web view's constraint.
- Keep a `Map<noteId, position>` so pausing A, playing B, and returning to A resumes.

### 3.3 `VoiceNote.tsx` — one component, two backends

- On the gated native platform: render **no `<audio>`**; the button calls the native player and the component subscribes to the store.
- On web (and iOS if unaffected): keep the current `<audio>` path unchanged. It works there; don't churn it.
- Select with the existing platform detection (`src/lib/platform.ts`), the same way other native-only behaviour is gated.

### 3.4 Waveform and duration, while you're here

- The waveform currently depends on Web Audio `decodeAudioData`, which fails on Mac (flat bars, cosmetic, pre-existing). Native playback makes duration authoritative via `AVAudioPlayer.duration`, which fixes the **27% duration overstatement** noted earlier without touching the recorder.
- The durable fix for waveforms remains **peaks computed by the sender and shipped in the `MediaRef`** (what Signal and WhatsApp do). That is a payload-schema change — optional field, backward-compatible fallback to flat bars — so keep it as a separate commit and confirm with Anmol before touching `MediaRef`.

## 4. Verify (nothing counts until this passes)

On Mac Catalyst, in a conversation with 40+ voice notes:

1. **Every** note plays, including the ones past the old ~30 line and the tail.
2. A newly arrived note plays immediately, with no reload and no re-unlock.
3. Notes play in any order, repeatedly, over several minutes, with no degradation.
4. Pause A → play B → return to A resumes at A's position.
5. The census shows **zero** `<audio>` elements on this platform.
6. Interruption (start music in another app) pauses cleanly and the UI reflects it.
7. Recording still works, and the audio session is left in the state the recorder expects after a play/record/play cycle.

Then re-verify on a real iPhone that the unaffected path is unchanged (or, if iOS was affected and is now gated native, that it works there too).

## 5. Clean up when it lands

- Delete `src/components/debug/` (`ExperimentAudio`, `useDebugRemountKey`) and the `--audio-experiment` conditions.
- Keep `scripts/audio-trial.sh` / `audio-batch.sh` / `audio-analyze.py` — the harness is reusable and its cooldown/baseline discipline is worth keeping.
- Update `STATUS.md` ("Deliberate behaviours") and `MAC_AUDIO_FINDINGS.md` with the resolution.
- Consider filing a WebKit bug for the loader-grant behaviour with the trial data; it is a genuine platform defect and the evidence is unusually good.

## 6. Constraints

Unchanged: frozen paths (`src/crypto/**`, `src/keystore/**`, `worker/**`, ratchet region of `src/lib/messaging.ts`) — none of this needs them. Public repo, no secrets. **Decrypted audio is plaintext of an E2EE message: keep it in memory, never write it to disk, never log it by content.** Commit by explicit path. `os.Logger` + `privacy: .public`; `/usr/bin/log`. Watch a regression test fail against pre-fix code before trusting it.
