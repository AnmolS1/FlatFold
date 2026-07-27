# Voice notes on "Designed for iPad" — what is proven, and what is left

Written 2026-07-26 after a long debugging session with ~12 device rebuilds. The
ruled-out list is the valuable part: several of these were re-tested more than
once because a plausible theory was recorded as fact and then believed.

**Read this before touching voice notes on Mac.** Everything below marked PROVEN
comes from a device log line, not from reasoning.

## The pipeline, stage by stage

| stage | state | evidence |
|---|---|---|
| Capability detection | **PROVEN** | `FlatFoldAudio isSupported → {"supported":true}` |
| Microphone permission | **PROVEN** | `authorizationStatus(.audio) = authorized` |
| Capture | **PROVEN** | `finalized (delegate) 83522 bytes, 5183 ms, peak -17.1 dB` |
| Container finalize | **PROVEN** | `(delegate)`, not `(watchdog)` |
| File is playable | **PROVEN** | `probe ok: 231360 frames @ 44100 Hz` — AVAudioFile parses it |
| Bridge transport | **PROVEN** | returns a path; no large payload in `TO JS` |
| Web-side file read | **PROVEN** | `discardRecording` is only called after a successful read |
| Encrypt + upload + send | **PROVEN** | the note appears in the conversation |
| **Playback** | **BROKEN** | note does not play; `WebProcessProxy::didBecomeUnresponsive` |

Every stage up to and including the send is confirmed working on device. The
remaining fault is at or after playback.

## Ruled out — do not re-test these

Each cost at least one rebuild, several cost more.

- **The codec.** `mp4a.40.2` is correct and required; `audioFormat.ts` picks it
  deliberately. Apple cannot decode WebM/Opus, and a bare `audio/mp4` lets
  Chrome choose Opus-in-MP4. Not the bug — but do not "simplify" it either.
- **The container.** `AVAudioFile` parses the finished file and reports the
  expected frame count. The bytes are a valid AAC-in-MP4.
- **File finalization.** `AVAudioRecorder.stop()` is asynchronous; reading on the
  next line yielded samples with no `moov` atom. Fixed by answering from
  `audioRecorderDidFinishRecording`. The log now shows `(delegate)`.
- **Input device failure.** Early builds logged `client stopping after failed
  start` and produced a header around nothing. Fixed by dropping
  `.defaultToSpeaker` and adding `prepareToRecord()`. Peak is now ~-17 dB, i.e.
  real speech.
- **The base64 bridge.** ~104 KB of base64 wedged the WebContent process outright
  — Capacitor delivers results by evaluating JS with the payload as SOURCE. Now
  returns a path read via `Capacitor.convertFileSrc`. This was a real bug and is
  fixed, but it was NOT the whole story: the hang moved rather than disappeared.
- **`res.ok` / HTTP status on the file read.** WKWebView's custom scheme handler
  replies with a plain `URLResponse`, so JS sees `status === 0` on success.
  Never gate a custom-scheme fetch on the status line.
- **Per-note media elements** (for the exhaustion class, not this hang). Every
  `VoiceNote` owning an `<audio>` exhausted WebKit's media-resource pool and
  surfaced as `MEDIA_ERR_SRC_NOT_SUPPORTED`, which reads as a codec error and is
  not one. Now one shared element in `lib/audioPlayer`.
- **Per-note `AudioContext`.** WebKit caps concurrent contexts; one per note,
  closed fire-and-forget, exhausted them. Now one shared context, decodes capped
  at 2 with an 8s timeout.

## The live hypothesis (UNVERIFIED)

`WebProcessProxy::didBecomeUnresponsive` now fires immediately AFTER the
recording is read, and playback is dead from then on. The only global audio state
this plugin mutates is `AVAudioSession`, and WebKit's media stack lives in the
same process that wedges.

The session was being left in `.playAndRecord`, **active, forever**. The latest
change restores `.playback` after each recording. Restoring the category is
deliberately not the same as `setActive(false, .notifyOthersOnDeactivation)`,
which was tried earlier and broke WebView playback by broadcasting a system-wide
"everyone else resume".

**If this does not work, the next thing to test is whether playback is broken
only AFTER a recording in the same launch.** That single observation splits the
remaining space cleanly:

- broken only after recording → the audio session is the cause; the next step is
  to stop touching `AVAudioSession` at all on Mac and see whether
  `AVAudioRecorder` works without it there.
- broken from a cold launch too → the session is innocent and the fault is in
  the web playback path (the shared player, the blob, or the MIME type
  `MediaAttachment` derives).

Nobody has made that observation yet, and it is cheaper than any further code
change.

## Process notes, because they cost more than the bugs

- **Every diagnostic added measured the artifact, never the delivery.** Size,
  peak, frame count, container parse — all of the file, none of the path it
  travelled. `didBecomeUnresponsive` sat in the logs for two rounds before it was
  read, because the file had already been decided as the suspect.
- **A theory recorded as fact gets believed.** "Blocked behind a Catalyst
  entitlement" was reasoned, never measured, and was wrong — the real cause was
  that the WebView has no `navigator.mediaDevices` at all. It cost several
  rounds. Anything not measured should say so in the same sentence.
- **Unit tests cannot see a render loop.** A `useSyncExternalStore` snapshot that
  was not cached shipped to a device and took the whole app down while 700 tests
  passed. Component changes need a browser before they need a device.
- **The web build runs in a normal browser.** Most of the failures in this round
  were web-layer and reproducible locally. Only `mediaDevices` absence and the
  media-resource pool genuinely require WKWebView.
