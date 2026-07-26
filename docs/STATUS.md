# FlatFold: current status, for a fresh reviewer

Written 2026-07-25 for a Cowork review session. It covers where the project
actually stands, which behaviours look like bugs but are deliberate, what has been
verified and how, and what is genuinely still open. Read this before filing
anything, because several of the most surprising behaviours in the app are
intentional and already documented.

## What FlatFold is

A free, open-source (AGPL-3.0), end-to-end encrypted messenger. Signal-grade
crypto, but no phone number and no email: a username is the whole identity. The
server stores usernames, registration dates, and public keys, and nothing else
that it can avoid. Message content is E2E encrypted and never readable server
side.

- Web: https://flatfold.ponderance.dev
- Preview (own worker + own D1, safe to test against): see `PREVIEW_ORIGIN` in
  `.env.asc` — the hostname carries a personal account handle, so it stays out of
  a doc that FULL_AUDIT_2 P1 proposes tracking in a public repo.
- iOS: TestFlight, build 2 (version 1.0)
- Source: https://github.com/AnmolS1/FlatFold

Stack: React + Vite + TypeScript + Tailwind v4 on the front end, Capacitor 8
(SwiftPM, not CocoaPods) for iOS, and a Cloudflare Worker backend with Durable
Objects for mailboxes, D1 for storage, and R2 for media.

## Status: the build is done and shipped

Every step of the native build order is complete and live. PRs #8 (48 commits),
#9 (prekey replenishment) and #10 (passkey unlock) are merged to `prod`; prod
worker version `f806820a`. Everything described here is deployed.

**FULL_AUDIT_2 response (2026-07-25) is on `feat/native-token-auth` and NOT yet
merged or deployed** — 7 commits covering A1–A4, S1, S2, S3, R1 and U1. See
"What is genuinely open" below for what it did and did not close.

| Area | State |
| --- | --- |
| Core messenger (M1 to M7) | Shipped. X3DH, Double Ratchet, groups via sender keys, media, PWA. |
| Sealed sender | Shipped, including the OHTTP relay and IP blinding. |
| Native iOS (Steps 1 to 7) | Shipped. Tab-bar nav, feature parity, themes, push, hardening. |
| D7 account features | Shipped. Change password, BIP39 recovery, TOTP 2FA, biometric unlock. |
| Passkey unlock (web) | Shipped 2026-07-25. WebAuthn PRF wraps the master key; Touch ID replaces retyping the password after a reload. |
| TLS pinning | Shipped and proven with both controls. See `TLS_PINNING.md`. |
| Release pipeline | Working. A `v*` tag builds and uploads to TestFlight via CI. |
| Compliance | US: nothing to file (public source is not subject to the EAR). France: ANSSI declaration accepted. |
| macOS, Android | **Not built.** In the original scope, never started. |

Tests: 641 passing. `tsc -b` and eslint are clean.

## The two-layer auth model, which trips everyone up

This is the single most confusing thing about the app, and it caused a real bug
already, so understand it before reviewing anything auth-shaped.

There are **two independent layers**, and being past one does not mean you are
past the other:

1. **The server session.** A signed, epoch-stamped token. On web it rides a
   SameSite=Strict cookie; on native it is a bearer token (the cookie is dead from
   `capacitor://`). Restored on load via `GET /api/auth/me`.
2. **The local keystore unlock.** Your encrypted local data is sealed under a key
   derived from your password with Argon2id. Unlocking it is a separate, local-only
   step.

So you can be signed in and still locked. That is the "Unlock this device" screen
(`KeystoreUnlockGate`), and it is not a login screen even though it asks for a
password.

The bug this caused: with a valid session and a locked keystore, `/login`
redirected to `/chat`, which rendered the gate again. Someone who had forgotten
that account's password had no way to switch accounts and no way to start
recovery. The only exit was the destructive panic wipe. Fixed on 2026-07-25: the
gate now offers "Forgot your password?" and "Not X? Sign in to another account",
and `/login` only redirects when the session is both signed in and unlocked.
Pinned by `test-ui/unlockGateEscape.test.tsx`, which was verified failing against
the pre-fix code.

## Deliberate behaviours: please do not file these as bugs

Each of these looks wrong at first glance and is intentional. If you disagree with
one, argue the tradeoff rather than reporting it as a defect.

- **A page reload asks for your password again** (unless passkey unlock is on).
  The Argon2-derived key lives only in a module-scoped Map in the JS heap. It is
  never in `sessionStorage`, because anything there is readable by any in-origin
  script or extension. So a reload drops it. See the comment at
  `src/keystore/index.ts`. This is a deliberate security-versus-convenience
  tradeoff, and it is in a frozen file. Three things soften it without weakening
  it: `autocomplete="current-password"` plus a hidden username field so password
  managers fill it, Face ID on iOS, and **passkey unlock on the web** (below).
- **Passkey unlock is not a "did the user authenticate?" gate.** It uses the
  WebAuthn **PRF** extension: the passkey derives a secret that never leaves the
  authenticator and only appears after a user-verification gesture, and that
  secret is HKDF'd into a key that the master key is *wrapped* under. What sits
  at rest is only the wrapped key, useless without that authenticator. The
  weaker design (verify a passkey, then hand over a key that was readable at
  rest anyway) was explicitly rejected, for the same reason it was rejected on
  iOS. No server is involved at all: the assertion is never transmitted, so a
  forged one buys nothing. The unlock button is deliberately **not**
  auto-triggered, because browsers gate WebAuthn on a user gesture and an
  unprompted Touch ID dialog on every reload is hostile. Details in THREAT_MODEL
  #21; enrollment is per-origin, so a passkey made on preview will not work on
  prod.
- **The accent colours are FOUR tokens each, not one, and the split is by
  surface rather than by shade.** `--color-sax` is the gold as a *fill*;
  `--color-sax-ink` is the gold rendered *on* the card; `--color-sax-on-orbit` is
  it on the console panel; `--color-on-sax` is the ink that sits *on* a sax fill.
  Same shape for crane and crease. This looks like over-engineering until you see
  what one token did: Vellum had darkened `--color-sax` so its text would read on
  parchment, which silently broke it as a button fill, while Paper kept it bright
  and left `text-sax` at 2.09:1 in the default theme. Both themes were "fixed" and
  both were wrong, because they were fighting over the same value. Do not
  re-merge them. `test-ui/themeContrast.test.ts` asserts every pairing per theme,
  and four repo-wide greps stop a component reaching past the tokens.
- **De-emphasised text uses a `-dim` token, never an opacity modifier.** Tailwind
  v4 compiles `/NN` to `color-mix(in oklab, …)`, which does NOT match an sRGB
  alpha model — measured 4.61:1 where the arithmetic said 4.99:1, i.e. optimistic
  in the unsafe direction. Precomputed `-dim` values have nothing mixed at render
  time, so the test and the browser agree by construction. `/NN` is still fine on
  fills and borders at the 3.0 bar.
- **Notifications say "New activity" and nothing else.** Every notification
  surface is content-free on purpose: the APNs push, the web tab notification, and
  the tab dot. None of them name a sender or show any message text. An OS
  notification that leaked "Alice: hey" would quietly undo the whole privacy
  model. See THREAT_MODEL residual #22.
- **An attachment can only be downloaded ONCE, by one device.** `ackMediaFetched`
  deletes the R2 copy as soon as any device has fetched and decrypted it, so a
  second device asking for the same voice note or image legitimately cannot get
  it. That is the retention posture working as intended — the server holds
  ciphertext only until it is collected — but it looks exactly like corruption,
  and it cost real debugging time during the 2026-07-25 Mac round. The UI now
  says so in words rather than showing a bare "Error".
- **Voice notes are recorded as AAC-in-MP4, explicitly, and that matters.**
  `MediaRecorder` left to itself picks WebM/Opus in Chrome and Firefox, which
  **Safari and WKWebView cannot decode at all** — so every note recorded in
  desktop Chrome was unplayable on every Apple device, silently, on the
  receiving end. Worse, asking for a bare `audio/mp4` is not enough: measured in
  a real Chromium, that yields `audio/mp4;codecs=opus`, an Apple-openable
  container holding a codec Apple cannot decode. `src/lib/audioFormat.ts` names
  `mp4a.40.2` for that reason. Do not "simplify" it back to the container.
- **Settings → About shows a build id (short SHA, `+` if the tree was dirty).**
  Not vanity: WKWebView keeps the previous JavaScript across a native rebuild
  unless the app is force-quit, and the web shell is pinned by a service worker.
  Two bug reports in the 2026-07-25 round (Touch ID "not enabling",
  swipe-to-reply "broken") were stale bundles and nothing else. Quote the build
  id in any report.
- **The browser notification says "via <domain>".** That attribution line is
  enforced by the browser and cannot be set or hidden by a page. Installing the
  PWA replaces it with the app name.
- **The app-switcher shows a branded cover instead of your chat.** Intentional, so
  message content cannot leak into an iOS snapshot. Residual #23.
- **The iOS simulator cannot reach a logged-in state.** Argon2 and HPKE WebAssembly
  segfault there. Use a real device for anything past the login screen. The
  simulator is still fine for launch-time work, which is how TLS pinning was
  verified.
- **The message list only renders the last 150 messages.** A deliberate cap with a
  "Load earlier" control, chosen over a virtualization dependency.
- **`manualChunks` is deliberately absent.** For a bundled `capacitor://` app it
  splits the same bytes across more files with no CDN and no parse win.

## Hard constraints

The crypto and backend are off limits. The canonical statement lives under
**"Hard constraints"** in `docs/redesign/HANDOFF_STEP6_CONTINUATION.md`, and that
copy is authoritative. Do not restate it elsewhere, because two copies will drift.

The short version, so you know it applies to you: do not change `src/crypto/**`,
`src/keystore/**`, `worker/**`, or the ratchet region of `src/lib/messaging.ts`.
The freeze has been lifted three times, each explicitly and narrowly: the D7
account protocol, one-time-prekey replenishment, and passkey unlock. Each came
with test vectors or property tests, a self-review, and device verification. Any
new exception needs the same explicit grant. A performance or convenience motive
is not enough: off-thread Argon2 was proposed for performance and was deliberately
declined on those grounds.

## How things are verified here

The project's verification discipline matters more than usual, because a lot of
the security claims are only meaningful if they were actually checked.

- **Two vitest projects** (`vitest.config.ts`). The `worker` project runs in
  workerd and has no IndexedDB, and `hash-wasm` is banned there. The `ui` project
  runs in jsdom with `fake-indexeddb` and a working `hash-wasm`. Put a test in the
  right one or it will fail for confusing reasons.
- **A schema-drift test** fails the build if the `users` table and the public
  `/transparency` page disagree. Any new column needs a `PersistedField` in
  `src/data/serverState.ts` and the migration registered in both
  `test/schema-drift.test.ts` and `test/setup.ts`, in the same commit.
- **Security claims are verified with both controls, not a happy path.** TLS
  pinning was proven by shipping a deliberately wrong pin and watching the API call
  fail at trust evaluation, then shipping the real pins and watching it succeed. A
  passing happy path alone proves nothing, because a pin that matches everything
  also lets the app work.
- **Regression tests are watched failing first.** The unlock-gate test was run
  against the pre-fix code to confirm it actually catches the bug.
- **Device verification is required for native work.** A real iPhone, not the
  simulator. Note that after a native rebuild the app must be force-quit and
  relaunched, because WKWebView otherwise keeps the old JavaScript.

Older verification screenshots were deleted in a docs cleanup on 2026-07-25. The
written record survives in `docs/redesign/verify/STEP1_VERIFY_LOG.md`, and the
per-feature evidence is described in the commit messages and in
`HANDOFF_STEP6_CONTINUATION.md`.

## What is genuinely open

1. ~~One-time prekey exhaustion.~~ **Resolved 2026-07-25.** The pool was generated
   once (20 keys at identity creation) and never replenished, so once drained it
   stayed drained and later authenticated-fallback handshakes used no-OTP X3DH.
   Fixed with replenishment: `GET`/`POST /api/keys/prekeys` plus
   `src/lib/prekeyReplenish.ts`, refilling to 20 when the pool drops to 8. The
   audit's suggested "last-resort prekey" was deliberately not implemented, since a
   reusable prekey discards the one-time-ness that gives it its value; THREAT_MODEL
   #14 reached the same conclusion independently. Severity stayed Low because
   `lookupBundle` tries the anonymous sealed path first and that path never
   consumes a prekey, so ordinary first contacts were unaffected. Touching the
   frozen `worker/**` and `src/keystore/**` was a sanctioned exception on D7 terms.
   The interesting part for a reviewer is the ordering: secrets are persisted
   locally before the public halves are published, so a crash can never leave a
   published key whose secret was lost.
2. **macOS and Android are unbuilt.** Only the iOS app exists. iPadOS comes free
   through the universal build, and Macs can run the iPad app, but there is no true
   Mac Catalyst or Android target.
3. **App Store submission items:** the D5 store copy and the D6 privacy label are
   drafted but not submitted. The review demo accounts now EXIST: `flatfold_review1`
   and `flatfold_review2` on prod, created and sign-in-verified 2026-07-25, sharing
   one password in `.env.asc`. Two of them because FlatFold is E2EE between real
   users and one account cannot demonstrate a conversation. The notes to paste into
   App Store Connect are `docs/redesign/D5b_app_review_notes.md`; they exist mostly
   to pre-empt four behaviours that read as bugs to a reviewer.
4. ~~The new themes' accent tokens were never eyeballed on device.~~ **Resolved
   2026-07-25.** They were worse than "best-fit": Vellum set `--color-orbit` to a
   light parchment while `SafetyNumberDialog` hardcoded `text-white`, so the
   safety-number screen — where a user confirms they are not being MITM'd —
   rendered at 1.27:1. A theme silently disabled a security control. Fixed by the
   token split above; now 13.17:1, verified in a real browser across all five
   themes and confirmed on device. Evidence in
   `docs/redesign/verify/FULL_AUDIT_2_CONTRAST_VERIFY.md`.
5. **`Chat.tsx` is still 1,728 lines.** The inbound-frame dispatch and the
   session-op chain now live in `src/lib/inboundDispatch.ts` with tests (the chain
   is what stops a reconnect flush clobbering its own ratchet state), but the D2
   `useMailboxSocket` / `useConversationState` extraction is deliberately NOT done
   — restructuring that much untested code alongside a theme migration is how you
   introduce the bug an audit didn't find. Tests first, extraction as its own change.
6. **`docs/` is closer to trackable, but not cleared.** FULL_AUDIT_2 P1 recommends
   putting the design docs under version control on the grounds that they hold
   nothing sensitive. That was not true: a live prod password and a personal
   device UDID were in the handoff doc. **Both were redacted 2026-07-25** and now
   live in `.env.asc` (gitignored), which the docs point at rather than quote.
   Nothing ever leaked — the directory has never been committed. Still open
   The personal account names and the preview hostname were redacted in the same
   pass and on the same reasoning: identifiers rather than secrets, but they tie
   the repo to a person. Re-run a scan before flipping the ignore, and remember
   git history is not undoable.
7. **Smaller follow-ups:** the native push title is a fixed generic rather than the
   user's custom decoy label (the setting's help text now says so explicitly);
   `@capacitor/local-notifications` and `initNativePushDisplay` are now inert and
   could be removed; `--color-orbit-ink` is defined in every theme block and used
   nowhere; and eslint's `brace-expansion` advisory is open, fixable only by an
   eslint 10 major.

## Latest handoff

`docs/redesign/HANDOFF_2026-07-26.md` — the FULL_AUDIT_2 response, the Mac
testing round, and what is still open (the ghost row with three failed fixes and
their ruled-out hypotheses, the microphone, and the macOS decision).
`docs/DESKTOP_SHELL_OPTIONS.md` is the Tauri-vs-Catalyst-vs-descope paper.

## Where things live

```
src/crypto/      X3DH, Double Ratchet, sender keys, primitives   [FROZEN]
src/keystore/    encrypted local store, identity record, recovery [FROZEN]
worker/          Cloudflare Worker: auth, keys, mailbox DO, push  [FROZEN]
src/lib/         platform detection, api client, messaging, push, webNotify
src/pages/       Chat.tsx (large, integration-heavy), Login.tsx
src/components/  UI, including KeystoreUnlockGate and the settings sections
ios/App/         Xcode project, custom Swift plugins, Info.plist (TLS pins)
docs/            THREAT_MODEL and TLS_PINNING are public; the rest is local
docs/redesign/   design specs D1 to D7, the build prompt, the live handoff
```

Only `docs/THREAT_MODEL.md` and `docs/TLS_PINNING.md` are tracked in git. The rest
of `docs/` is gitignored, so anything deleted there is gone permanently.

## Where a review would help most

Ranked by where the real risk is, rather than where findings are easiest:

1. **The prekey exhaustion question above.** A second opinion on whether
   replenishment is the right fix, and on what a safe write ordering looks like,
   would be genuinely useful before any frozen file is touched.
2. **The passkey unlock, since it is the newest crypto.** `src/lib/webauthnPrf.ts`
   and the `PASSKEY_STORE` half of `src/keystore/index.ts`. Worth scrutiny: the
   PRF-to-wrapping-key derivation, whether the wrap at rest genuinely leaks
   nothing, and the failure paths (a stale wrap is deleted so it stops being
   offered). Note the unit tests necessarily stub the WebAuthn ceremony itself,
   because a real authenticator cannot run headless. That gap is exactly how an
   enrollment hang shipped and had to be caught by hand: two ceremonies ran back
   to back and the second had no user activation left, so its promise never
   settled. Every WebAuthn call is now bounded by an explicit timeout.
3. **`src/pages/Chat.tsx`.** It is the largest file and carries the WebSocket
   lifecycle, the session-op queue, inbound decryption, and the offline flush. It
   has no component test. If anything is subtly wrong, it is probably here.
4. **Whether the privacy claims still hold end to end** now that a web
   notification surface exists. THREAT_MODEL #22 was extended for it; check that
   the code matches the claim.
5. **Accessibility.** There was a pass, and `test-ui/dialogAccessibility.test.tsx`
   covers focus traps, but the five themes have not all been checked for contrast
   on device, and the new toast position and unlock-gate links are unaudited.
6. **The web experience specifically.** Most recent attention went to iOS. The web
   app got its connection handling and notifications only in the last change.

A note on scope: several things that look like obvious improvements were already
considered and declined on purpose, and the reasoning is recorded. Before
proposing bundle splitting, off-thread crypto, message-list virtualization, or
storing the keystore key across reloads, check the "Deliberate behaviours" section
and the Step 6 notes in the handoff, so the review spends its time on new ground.
