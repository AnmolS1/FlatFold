# Research brief — voice-note playback on Mac (Catalyst)

**For a deep research + diagnosis pass.** Everything below was measured on a
signed Mac Catalyst build on 2026-07-26/27. Claims are marked MEASURED or
UNVERIFIED; nothing here is theory presented as fact, because that failure mode
cost this project days already.

**The question:** why do `<audio>` elements in a `capacitor://localhost`
WKWebView stop loading past ~31 elements, and is the fix in `347944c` the right
shape or a workaround for something else?

---

## 1. What the app does

FlatFold is an E2EE messenger. A voice note is: AAC-in-MP4 bytes → decrypted
locally → `URL.createObjectURL(new Blob([...], {type:'audio/mp4'}))` → passed to
`src/components/chat/VoiceNote.tsx`, which renders an `<audio>`.

Relevant files:

| file | role |
| --- | --- |
| `src/components/chat/VoiceNote.tsx` | the player. All the caveats are in its comments. |
| `src/components/chat/MediaAttachment.tsx` | creates/revokes the blob URL |
| `src/lib/audioContext.ts` | shared AudioContext + decode cap, for waveforms |
| `ios/App/App/FlatFoldAudioPlugin.swift` | native recorder (Mac only) |
| `ios/App/App/MainViewController.swift` | the DEBUG capability probe + census |

---

## 2. The headline measurement

A conversation with 37 voice notes, census taken from the running app:

```
audioEls:37  withSrc:37
ready:   1101111011111111111111101111101100000
network: 1131111311111111111111131111121122222
errs:    --4----4---------------4-------------
pool:    {"active":0,"waiting":0,"unavailable":false,"hasContext":true,
          "ok":0,"timedOut":0,"failed":37}
```

MEASURED:
- 31 of 37 elements reach `readyState 1`. **The last 6 never do** — they sit at
  `networkState 2` (LOADING), `readyState 0`, and `error` is **null**. Not slow;
  they never progress, over minutes.
- A note that cannot load **HANGS SILENTLY**. The `code=4`
  (`MEDIA_ERR_SRC_NOT_SUPPORTED`) errors belong to **different, already-loaded**
  notes that get evicted. This misattribution cost two debugging rounds — the
  visible error is never on the broken note.
- All 37 Web Audio `decodeAudioData` calls fail immediately (`failed:37`,
  `timedOut:0`). This is **pre-existing and cosmetic** — it only drives the
  waveform, is documented in `VoiceNote.tsx`, and affects old and new notes
  alike. It is NOT the playback bug. Do not chase it first.

## 3. Ruled OUT by measurement — please do not re-test these

Each cost at least one build/reproduce cycle.

| Hypothesis | How it was killed |
| --- | --- |
| **Container corrupt** | `stco[0]=57344` == `mdatPayload@57344` exactly. The sample index points precisely at the audio. `AVAudioFile` opens it: `frames=174016 rate=44100 ch=1`. The large `free` atom AVAudioRecorder leaves (56 KB of 75 KB) is padding, not damage. |
| **Blob URL revoked early** | Instrumented create/revoke: **16 CREATED, 0 REVOKED**. `MediaAttachment` is `memo`ised and its effect does not churn. |
| **Audio session category** | A real asymmetry WAS found and fixed (below), but restoring `.playback` did not change playback at all. |
| **Codec / format** | `mp4a.40.2` AAC-LC, deliberate and required (`src/lib/audioFormat.ts`). Old notes in the same list, same MIME, play fine. |
| **`preload` value** | `"none"` and `"metadata"` behave identically for the stuck elements. |
| **Explicit `load()`** | No effect. |
| **Multiple app instances competing** | Checked: exactly 1 process. |
| **Web Audio decode pool** | `active:0 waiting:0 unavailable:false` while notes hang. Its cap is not binding. |

## 4. The fix that is in, and what would falsify it

`347944c` — **create the `<audio>` element on the play gesture, not at mount**,
capped at `LIVE_NOTE_LIMIT = 6` live elements with LRU teardown.

Reasoning: the budget appears to be on **elements**, not on loaded resources.
That is inferred from one strong negative result — an earlier attempt
(`dd31836`, reverted in `594e7e5`) withheld `src` from all 37 elements and
playback broke for **every** note, not just new ones. If the budget were on
loaded sources, that should have worked.

**UNVERIFIED and the most important thing to check:** whether the ceiling is
really on element count, and what the real number is. `31` is one observation
from one conversation on one machine. It could be a coincidence of that
conversation's size.

Falsifying evidence would be: with `LIVE_NOTE_LIMIT = 6`, a note still hangs.

Also note `594e7e5`'s commit message asserts "a late load never completes." That
is now believed WRONG — the late loads in that experiment failed because 37
elements already existed. Read that commit as evidence, not as conclusion.

## 5. Questions worth actual research

1. **What is WebKit's real limit here?** Is there a documented or source-visible
   cap on concurrent `HTMLMediaElement`s (or on media loads) in iOS-family
   WebKit / Mac Catalyst? Names to look for around `MediaElementSession`,
   `PlatformMediaSessionManager`, `maximumMediaElement*`. Is it per page, per
   process, or per session? Does it differ for `blob:` vs `https:`?
2. **Does the custom scheme matter?** The page origin is
   `capacitor://localhost`. Does media loading behave differently there than on
   `https://`? This connects to a second measured oddity: `navigator.mediaDevices`
   is **absent** on both Mac shells at `secure: true` (see §7).
3. **Is `blob:` the aggravating factor?** Would serving the same bytes through a
   Capacitor custom-scheme URL (as the recorder already does via
   `convertFileSrc`) avoid the ceiling entirely? This is the most promising
   untried direction and would sidestep the budget rather than ration it.
4. **Is 6 the right cap, and is LRU teardown the right policy?** Tearing down a
   paused note loses its position.
5. **Why does Web Audio `decodeAudioData` fail on Mac for AAC that the media
   element decodes fine?** Cosmetic today (waveforms are flat on Mac), but it is
   an unexplained platform difference and may share a root cause.

## 6. How to reproduce and observe — the loop works, use it

Catalyst can be built, launched and read from the CLI. This is the single
biggest productivity difference from the old "Designed for iPad" build, where
`xcodebuild` refuses outright.

```bash
# Web bundle. NOT `npm run build:native` — that runs `cap sync`, which silently
# flips the pod mode back to iOS and makes the NEXT Catalyst build fail with a
# misleading `Unable to resolve module dependency: 'IONFilesystemLib'`.
npx vite build && node scripts/gen-sw-manifest.mjs \
  && node scripts/inject-native-csp.mjs && npx cap copy ios

cat ios/App/Pods/.flatfold-pod-mode      # must say `catalyst`

cd ios/App
osascript -e 'quit app "App"'            # WKWebView keeps old JS otherwise
xcodebuild -workspace App.xcworkspace -scheme App \
  -destination 'platform=macOS,variant=Mac Catalyst' \
  -derivedDataPath build/DDcat -configuration Debug build
open -n build/DDcat/Build/Products/Debug-maccatalyst/App.app
```

Reading the instrumentation:

```bash
/usr/bin/log show --last 2m --info --debug \
  --predicate 'subsystem == "dev.flatfold"' --style compact
```

**Two traps that cost real time:**

- **`NSLog` produces NOTHING** from this target when launched outside Xcode. All
  the recorder's original instrumentation was invisible on the platform being
  debugged. Use `os.Logger`.
- **`os.Logger` redacts interpolations to `<private>` by default.** Every field
  must be `privacy: .public` or the probe looks like it failed.
- `log` is shadowed in this zsh; use `/usr/bin/log`.

What is already instrumented (all DEBUG-only):
- `MainViewController.probeMacCapabilities` — platform flags + `mediaDevices`
- `MainViewController.logAudioCensus` — every 10s: per-element `readyState` /
  `networkState` / `error`, plus `audioContext.ts` pool state
- `FlatFoldAudioPlugin.describeContainer` — MP4 atom layout + `stco[0]`
- `VoiceNote` / `MediaAttachment` — per-note tagged lifecycle
  (`[abc123] toggle …`). **Keep the tags.** Untagged media logs are what made
  this bug expensive.

## 7. Adjacent measured facts

- **`navigator.mediaDevices` is absent on BOTH Mac shells**, at `secure: true`,
  origin `capacitor://localhost`, with `NSMicrophoneUsageDescription` present and
  `com.apple.security.device.audio-input` in the signed binary. Catalyst does not
  fix it. Hence `FlatFoldAudioPlugin`.
- **`ProcessInfo.isiOSAppOnMac` is FALSE under Catalyst** (`isMacCatalystApp` is
  true). Gating on it made the native recorder inert on Catalyst — fixed in
  `31e6b70`. Recording on Catalyst is now VERIFIED WORKING on device.
- **The microphone is genuinely released** after recording — from the CoreAudio
  HAL, not from an API returning cleanly:
  `recorder=nil category=AVAudioSessionCategoryPlayback inputRunning=false`.
- **Session restoration was wired to the failure path only.** It lived in
  `cleanUp()`, which the success path skips deliberately (it deletes the file the
  web layer still has to read). Fixed; did not affect playback.
- **`durationMs` rides inside the `MediaRef`**, so it is present on RECEIVED
  notes, not only locally recorded ones. This is why a note can show its duration
  with no media element at all.
- **UNVERIFIED:** `pendingDurationMs` comes from `rec.currentTime` sampled before
  `stop()`, and overstates — 5017 ms reported for 174016 frames @ 44100
  (3946 ms). Cosmetic. The authoritative number is `probe.length /
  probe.fileFormat.sampleRate`, already available at that point.

## 8. Hard constraints

- **Frozen:** `src/crypto/**`, `src/keystore/**`, `worker/**`, and the ratchet
  region of `src/lib/messaging.ts`. None of this work needs them.
- The repo is **PUBLIC**. No secrets, tokens, or personal identifiers in commits
  or docs. `.env.asc` is gitignored and holds them.
- Voice-note temp files are **plaintext audio of E2EE messages**. They must not
  outlive the send, must not be copied somewhere readable, and must not be logged
  by content. The container dump logs structure only, deliberately.
- Commit by explicit path, never `git add -A`. Do not commit
  `App.xcscheme`, `AppUITests.xcscheme`, `CapApp-SPM/Package.swift`, or `brand/`
  — long-standing local files.
- Verification discipline: a passing happy path proves nothing. Watch a
  regression test fail against the pre-fix code first.

## 9. Suggested order

1. Confirm or refute the element-count ceiling, and find its real value. That
   decides whether `347944c` is a fix or a coincidence.
2. Research WebKit's actual limit and whether `capacitor://` or `blob:` changes
   it (§5.1–5.3).
3. If the ceiling is real and unavoidable, evaluate serving notes via
   `convertFileSrc` instead of `blob:` — it sidesteps rather than rations.
4. Only then: the Web Audio decode failure, and the duration overstatement.
