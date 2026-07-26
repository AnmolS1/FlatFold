# Handoff — continue the FlatFold native build (Step 6 onward)

**STATUS 2026-07-25: the whole build order (Steps 1–7 + D7) is DONE, MERGED, and
LIVE.** PR #8 (48 commits) merged to `prod` with CI green; the worker is deployed
(Version ID `5e572c4d`, verified live); TestFlight has build 2 (v1.0) from tag
`v1.0.0`; the France ANSSI déclaration is accepted. Everything below is retained
as the record of how it was built and what is deliberately still open — read the
"Hard constraints" and "What's next" sections before changing anything.

> ⚠️ `docs/redesign/**` is **gitignored** (local design docs). Code is committed;
> these docs are not. Don't `git add` them.

Read first: `docs/redesign/HANDOFF_TO_CLAUDE_CODE.md` + `NATIVE_BUILD_PROMPT.md`
(the original mandate), then this file.

## Hard constraints (the old §3 — still binding)

These were the mandate's §3, and they governed every step of this build. The brief
that stated them (`CLAUDE_COWORK_APP_REDESIGN.md`) has been deleted as a spent
prompt doc, so they are restated here as the canonical copy:

1. **The crypto and backend are OFF-LIMITS.** Do not change `src/crypto/**`,
   `src/keystore/**`, `worker/**`, or the ratchet region of `src/lib/messaging.ts`.
   The one sanctioned exception was the D7 account-recovery / 2FA / change-password
   protocol, which was granted explicitly and given ratchet-grade rigor (test
   vectors, property tests, self-review). Any *future* exception needs the same
   explicit grant — a perf or convenience motive is not enough (see the deferred
   off-thread-Argon2 decision below).
2. **Reuse the live native seams** rather than inventing parallel ones:
   `src/lib/platform.ts` (`isNativePlatform()`, `apiOrigin()`, `wsOrigin()`),
   `src/lib/nativeToken.ts`, `src/lib/apiClient.ts`.
3. **Keep the web build working.** Every native behaviour is gated on
   `isNativePlatform()`; the web path must stay byte-for-byte functional.
4. **Preserve the privacy behaviours** — content-free notifications, no
   third-party SDKs/analytics/trackers, no remote app shell, nothing that leaks a
   sender or message text.
5. **Maintain accessibility** — the a11y pass (focus traps, labels, contrast) is
   part of "done", not a follow-up.

---

## What's done (all committed, all on prod)

- **Steps 1–2** — viewport/keyboard/tab-bar/composer; full feature parity (QR,
  file save, haptics, block, panic gesture, etc.). Device-verified.
- **D7 Phase 1 — change password.** Crash-safe two-wrap re-key (identityRecord.ts
  stage/promote/abort); server rotates verifier + epoch atomically, fresh token.
- **D7 Phase 2 — recovery code.** BIP39 12-word; dual-salt Argon2id (K_rec wraps
  identity, recAuth is the server verifier); migration 0008; RecoverForm +
  Settings enroll. Option B: restores identity keys + contacts (no safety-number
  change); history never leaves the device.
- **D7 Phase 3 — TOTP 2FA.** RFC 6238 (crypto.subtle HMAC-SHA1), replay guard,
  at-rest secret encryption (SESSION_SECRET-derived), single-use backup codes;
  migration 0009; login gate; Settings enable/disable with QR + manual key.
- **D7 Phase 4 — biometric unlock.** Custom Secure-Enclave plugin
  (`FlatFoldBiometricPlugin.swift`): MK stored in a Keychain item gated by
  `.biometryCurrentSet`, read only via a live Face ID match — Model A, no at-rest
  regression. Unlock gate + Settings toggle.
- **Step 4** — five themes (Paper/Ink/Vellum/Graphite/Midnight Crane) + Automatic,
  Settings picker, About section, themed light/dark launch splash.
- **Step 5** — app-switcher privacy overlay (AppDelegate); **content-free push,
  now fully working end to end** (see the war story below).
- **App-icon picker** — manual (iOS alerts on each change), 3 branded alternates
  (Vellum/Graphite/Midnight) via `FlatFoldAppIconPlugin.swift`.
- **Disclosure** — THREAT_MODEL residuals #19–#23 cover recovery, 2FA, biometric,
  push, and the app-switcher overlay. `/transparency` auto-tracks serverState.

**Tests: 406 green. tsc -b + eslint clean.** Prod worker deployed
(flatfold.ponderance.dev). The test iPhone runs a **Debug** build pointed
at **prod**.

---

## The push saga (READ THIS — it's the least-obvious subsystem)

Native push took a long chain of fixes; each masked the next. All are committed
(`fix(push): deliver native notifications end to end`). If push breaks, suspect
these in order:

1. **AppDelegate must relay APNs callbacks.** Capacitor's PushNotifications
   listens on NotificationCenter; `AppDelegate` posts
   `.capacitorDidRegisterForRemoteNotifications` from
   `didRegisterForRemoteNotificationsWithDeviceToken`. Without it,
   `register()` never resolves. (Same class of bug bit plugin registration — see
   below.)
2. **aps-environment is per-config.** Debug signs with a *development* profile, so
   a hardcoded `production` entitlement makes registration fail. `App.entitlements`
   = production (Release), `App.debug.entitlements` = development (Debug), set via
   `CODE_SIGN_ENTITLEMENTS` per configuration.
3. **Client closes the WS on background** (Chat.tsx `appStateChange`), suppressing
   auto-reconnect until foreground (`backgroundedRef`). Otherwise the Durable
   Object keeps seeing the device "online" and live-delivers into a dead socket
   instead of pushing. Push only fires when the recipient's `getWebSockets()` is
   empty.
4. **Alert push, not silent.** `worker/push.ts` sends a content-free ALERT
   (`aps.alert.title = "New activity"`, no text/sender) — a silent
   content-available push does NOT trigger Capacitor's handler in the background,
   so nothing displays. iOS shows the alert directly.
5. **APNs keys are per-environment here.** Prod key `MTT8A4GJJY`; sandbox key
   `C3Z3B54G4D`. `signApnsProviderToken(env, environment)` uses the sandbox key
   (`APNS_KEY_SANDBOX` / `APNS_KEY_ID_SANDBOX` secrets, already set on prod) for
   sandbox tokens, falling back to prod. `sendWakeupToUser` tries both
   environments and remembers which returned 200.

**Debugging technique that worked:** `npx wrangler tail flatfold --format json`
while triggering a send. Temporary `console.log`s in the DO deliver paths + the
APNs response were the decisive diagnostic (now removed — they logged usernames,
don't reintroduce them in prod). The clean test needs the recipient genuinely
**offline** (backgrounded, WS closed) and the sender **online** (the web account was
on the web app).

**Follow-up (not done):** the native push title is a *fixed* generic, not the
user's per-account custom decoy label (which is client-side, web-only). Reliable
custom decoy needs server-side storage of the label or a Notification Service
Extension. Also: `@capacitor/local-notifications` + `initNativePushDisplay`
(src/lib/nativePush.ts) are now **inert** (superseded by the alert push) — safe to
remove in a cleanup, but harmless (they never fire, since push only happens while
offline/backgrounded).

---

## Capacitor 8 gotcha: app-local native plugins need manual registration

Capacitor 8 instantiates plugins from a generated `packageClassList` built from
installed *packages* only — there is **no ObjC-runtime auto-discovery**. Our two
app-local plugins (biometric, app-icon) are registered by hand in
`MainViewController.capacitorDidLoad()` (a `CAPBridgeViewController` subclass wired
into `Main.storyboard`). This survives `cap sync`. Any new app-local plugin must
be registered there too.

---

## What's next

### Step 6 — performance — AUDITED, closed as already-satisfied (2026-07-25)
Measured, not guessed. Chunk attribution (`grep` the built `dist/client/assets/*.js`):
- **HPKE** (`@hpke/core`, sealedFetch.ts) is in the **`Chat` chunk (197 kB)**, not
  the main index — already deferred behind login. **jsQR** is its own lazy chunk.
  Chat itself is lazy-split. So "code-split the heavy paths" is effectively done.
- The **406 kB main `index` chunk = React + @noble + app code**, all needed at
  login. The only inlined WASM blobs total **~14 KiB** (and hash-wasm compiles
  Argon2 lazily at call time) — no deferrable dead weight. Nothing meaningful to
  split out without editing frozen `src/keystore`/`src/crypto`.
- `manualChunks` was **deliberately NOT added** — for a bundled `capacitor://`
  app it splits the same bytes across more files with no CDN and no parse win.
  Motion, not improvement.
- Object URLs are revoked (`MediaAttachment` unmount effect); `overscroll-contain`
  + `useVisualViewport` already cover WKWebView scroll/keyboard (Steps 1–2);
  message list already caps DOM to a 150-message window.
- **Off-thread Argon2id — DEFERRED by explicit user decision (2026-07-25).** The
  only high-value item left, but it's in frozen `src/keystore/crypto.ts` and moving
  MK bytes into a Web Worker heap is a security-posture change. The block it removes
  is a one-time sub-second unlock freeze already behind a spinner — not worth
  unfreezing crypto. If revisited, treat as a D7-style sanctioned exception (test
  vectors proving byte-identical derivation, self-review, device-verify).

### Step 7 — release pipelines + hardening
Split into Half A (hardening, non-outward, autonomous) and Half B (submission,
outward-facing, GATED on explicit user go-ahead). User chose "harden first."

**Half A — hardening:**
- **TLS public-key pinning — DONE + PROVEN (2026-07-25, commit `ef6d68f`).**
  `NSPinnedDomains` in Info.plist pins `flatfold.ponderance.dev` to GTS Root R4 +
  ISRG Root X1 (the two CA roots Cloudflare rotates between). This is the only pin
  that reaches WKWebView fetch/WS (WebKit's networking process, not URLSession).
  Verified with negative + positive controls on-sim against the live cert
  (bogus pin → `-9802`/`-1200` block; real pins → Trust result 0 + HTTP 401).
  THREAT_MODEL #24 (honest CA-set residual); rotation runbook `docs/TLS_PINNING.md`
  (force-tracked; `/docs/*` is gitignored except THREAT_MODEL + this). Installed on
  the test iPhone — **user should confirm real E2E use still works with pinning on.**
- **Release web-inspector off — DONE** (`MainViewController` `#if !DEBUG`
  `isInspectable=false`; Release-compile-verified). Source maps already absent;
  bundled CSP already tight (`default-src 'none'`). See [[capacitor-wkwebview]].
- **REMAINING in Half A:** re-run the security audit against the native surfaces
  (jailbreak/root soft-warning is optional per §7; reproducible-build hashes
  published is the verifiability item). App Privacy label unchanged (pinning adds
  no data collection); `/transparency` unchanged (server-data-scoped, pinning is a
  client transport defense).

**Half B — release pipelines + store submission — STAGED + VALIDATED (2026-07-25,
commit `2e51f30`), upload still GATED.** The whole pipeline was verified end-to-end
without any upload:
- **Fastlane `verify` lane added** (`fastlane/Fastfile`) — `match readonly` + ASC
  `latest_testflight_build_number`. Ran clean: ASC key authenticates, the App Store
  cert + profile ("Apple Distribution: Anmol Saxena (G2KBQH7KWT)" / "match AppStore
  dev.flatfold") decrypt and install, and **build 1 already exists on TestFlight**
  (Phase 1 shipped it, so the build→sign→upload path is proven, not theoretical).
  Run it with `set -a; source .match.env; set +a; ~/.gem/ruby/3.4.0/bin/fastlane ios verify`.
- **Build-number collision FIXED** — pbxproj pins `CURRENT_PROJECT_VERSION=1` with no
  bump script, so the next upload would have bounced as a duplicate of build 1. The
  `beta` lane now sets `next = latest_testflight_build_number + 1` and injects it via
  `build_app(xcargs: "CURRENT_PROJECT_VERSION=#{next}")`. See [[apple-distribution]].
- **CI ready:** `.github/workflows/ios-release.yml` (push a `v*` tag → `fastlane ios
  beta` on macos-15) is correct and SHA-pinned; all 5 GH Actions secrets are set
  (`ASC_KEY_BASE64`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `MATCH_PASSWORD`,
  `MATCH_GIT_BASIC_AUTHORIZATION`).

**RELEASED TO TESTFLIGHT (2026-07-25):** branch pushed; PR #8 opened (→ `prod`, NOT
merged); tag `v1.0.0` pushed → `ios-release.yml` run 30146962182 SUCCEEDED → **build 2
(version 1.0) uploaded to TestFlight.** The build-number fix worked (built CFBundleVersion
2, no collision). GitHub Actions is FREE for this PUBLIC repo (macOS included) — the
release cost nothing. To cut the next build: `git tag v1.0.x && git push origin v1.0.x`.
This Mac can't distribute interactively (Organizer only), which is why release goes
through CI; see `apple-distribution`.

**Store-submission open items (not blockers for TestFlight, verify before App Store
review):** (1) **Export compliance** — Info.plist has `ITSAppUsesNonExemptEncryption
= false`, but FlatFold *does* use non-exempt E2EE crypto; build 1 passed TestFlight
with it, but confirm the intended posture against `docs/ENCRYPTION_COMPLIANCE.md` /
`docs/FRANCE_ENCRYPTION_DECLARATION.md` before store review (likely needs the ENC
self-classification path, not a bare `false`). (2) D5 store copy, D6 privacy label,
the demo review account. (3) `MARKETING_VERSION` is `1.0` — set the public version
string deliberately for the first release. (4) Reproducible-build hashes: iOS IPAs
are not bit-reproducible (Apple signing); the honest verifiability claim is the
public AGPL source + deterministic `vite build` web assets, documented at release.

### Smaller follow-ups
- **macOS app is NOT built.** Only the iOS universal app exists (auto-offered as
  "iPad App on Mac"). A true Mac Catalyst / Electron target is unbuilt — in scope
  per the mandate, unreached.
- **Theme contrast:** the D3 spec verified core text/bg pairs for all five themes,
  but the new themes' `sax`/`orbit` accents (verified-checkmark, verification
  panel) are best-fit values flagged "verify if changed." Eyeball Vellum/
  Graphite/Midnight on-device.
- **Custom decoy on native** + removing the inert local-notifications handler
  (see push section).

---

## Workflow / commands (all verified this session)

- **Two vitest projects** (`vitest.config.ts`): `worker` (workerd — NO IndexedDB,
  hash-wasm BANNED) runs `test/**` + `src/**/*.test.ts`; `ui` (jsdom +
  fake-indexeddb + working hash-wasm) runs `test-ui/**`. `matchMedia` is absent in
  jsdom — guard it (theme hook does).
- **serverState drift test**: any new `users` column needs a `PersistedField` in
  `src/data/serverState.ts` + the migration registered in BOTH
  `test/schema-drift.test.ts` and `test/setup.ts`, same commit.
- **Device build/install (Debug, on the test iPhone).** Its UDID is a personal
  hardware identifier and is not in this file — see `IOS_DEVICE_UDID` in
  `.env.asc`, or read it off `xcrun devicectl list devices`. Substitute it for
  `$UDID` below (`export UDID=$(...)`):
  ```
  npm run build:native                                    # web→native + cap sync
  cd ios/App && xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
    -destination 'platform=iOS,id=$UDID' \
    -derivedDataPath build/DDdev -allowProvisioningUpdates build
  xcrun devicectl device install app --device $UDID \
    build/DDdev/Build/Products/Debug-iphoneos/App.app
  ```
  **After a native rebuild the user MUST force-quit + relaunch** — WKWebView keeps
  the old JS otherwise. Over-install keeps data; `uninstall` WIPES it.
  Add a Swift file / bundle resource to the target with the `xcodeproj` Ruby gem
  (used for both custom plugins + the alt icons).
- **Prod deploy:** `npm run build && npx wrangler deploy` (verify
  `dist/flatfold/wrangler.json` name == `flatfold` first — a stray build can
  target the wrong worker). **Preview:** `CLOUDFLARE_ENV=preview npm run build &&
  npx wrangler deploy` (the vite-plugin picks env at BUILD; `--env preview` is
  IGNORED — memory `cloudflare-workers`). Preview =
  the preview worker (`PREVIEW_ORIGIN` in `.env.asc`; own D1).
- **iOS SIM can't reach logged-in states** (Argon2/HPKE WASM SIGSEGV) — real
  device only. `wrangler tail flatfold` for live worker logs. `timeout` isn't on
  macOS (use `gtimeout` or run_in_background).
- **Commit only by explicit path** (never `git add -A`): the tree has pre-existing
  uncommitted `.gitignore`, `App.xcscheme`, and untracked `brand/` files that are
  NOT yours. Trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` +
  the Claude-Session line.
- **Test accounts** on prod: `test1`…`test12`. Their shared password is NOT in
  this file — see `PROD_TEST_PASSWORD` in `.env.asc` at the repo root (gitignored).
  Redacted 2026-07-25: FULL_AUDIT_2 P1 proposes tracking `docs/` in git, and the
  repo is public, so a live prod password could not stay in a doc that a future
  reader might reasonably commit. The user's own personal account names are not
  here either — see `PERSONAL_ACCOUNT_IOS` / `PERSONAL_ACCOUNT_WEB` in `.env.asc`.

## Suggested first move
Confirm the tree is clean + tests green (`npx vitest run`, `npx tsc -b`), then
start Step 6 with a cold-start + bundle audit, device-verified. Hold Step 7's
TestFlight upload for an explicit go-ahead (it's outward-facing + billable).
