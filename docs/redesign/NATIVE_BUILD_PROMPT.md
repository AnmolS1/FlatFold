# Claude Code — FlatFold native build: redesign + full parity + account features + iOS/macOS/Android, optimized and hardened

The build order for the native apps. Read the whole design set first: the §3 hard constraints (restated under "Hard constraints" in `redesign/HANDOFF_STEP6_CONTINUATION.md`), `redesign/D2_interaction_spec.md`, `redesign/D3_themes.md`, `redesign/D4_icon_and_splash.md`, `redesign/D5_appstore_copy.md`, `redesign/D6_app_privacy_label.md`, and `redesign/D7_account_recovery_design.md`. The chosen direction and its mockups are the concrete UI targets (three Fable mockups: conversation list + tab bar, chat + composer, settings).

**Chosen design:** Direction C (dense, gesture-forward) with a bottom tab bar of **Chats / Contacts / Settings**. Build to the mockups; where they and prose disagree, the mockups win for layout, D2 wins for behavior.

## 1. Constraints (unchanged) and the one scoped exception

- Do not change `src/crypto/**`, `src/keystore/**`, `worker/**`, or the ratchet region of `src/lib/messaging.ts` — **except** the account-recovery and change-password protocol in D7, which necessarily touches the keystore and worker. Treat that exception as crypto-critical: spec test vectors, property tests, and a self-review, the same discipline as the ratchet. Nothing else in the redesign touches crypto.
- Reuse the live backend and native seams (`src/lib/api.ts`, the `wss://` + bearer subprotocol, `src/lib/nativeToken.ts`, `src/lib/platform.ts`). Keep the web build working and unregressed; gate native-only behavior on `isNativePlatform()`. Carry accessibility forward and extend it (D2 §5). Preserve every privacy/security behavior.

## 2. Feature parity — the native apps do EVERYTHING the web app does

No feature is web-only. Verify each is present and native-correct: 1:1 and small-group messaging; images, files, and voice notes; disappearing messages (per-conversation timer); **safety-number verification including QR display + camera scan**; **contact add by exact username**, plus contact removal/block; **account deletion**; **panic wipe** (deliberate two-step, plus a native equivalent of the reset chord, working while locked and offline); **local-only search**; the **decoy notification label**; **sign out** and **sign out everywhere**; theme switching (D3); content-free push. Then add the new account features in §4. If anything on the web has no native home, stop and flag it — parity is a requirement, not best-effort.

## 3. The redesign (build to the mockups + D2)

- **Navigation:** bottom tab bar (Chats / Contacts / Settings). Chats = the dense list with swipe pin/archive and header search + compose. Contacts = add-by-username, the contact list, and per-contact verify/remove. Settings = the grouped screen in the mockup.
- **List / chat / composer:** exactly per the mockups and D2 §0 — inputs ≥16px, a `visualViewport`-docked composer, no floating FAB, `env(safe-area-inset-*)`, 44pt targets, swipe-to-reply, long-press action sheet, the reduced-motion-aware paper-fold send. This removes the zoom/keyboard/FAB bug class; build and verify it on-device before anything else.
- **Other surfaces:** verification/QR, onboarding (explain the two-lock model plainly), keystore-unlock, media viewer — per D2.
- Decompose `Chat.tsx` into hooks/components (`useMailboxSocket`, `useConversationState`, per-surface components) **without touching the ratchet region**.

## 4. Account features (build per D7 — crypto-careful)

- **Two-factor auth (TOTP) for login** — optional, opt-in, standard RFC 6238 (works with any authenticator; do NOT integrate a vendor like Duo). Enable via QR in Settings, require the code after the password on login, generate one-time backup codes. Pair with **stay-signed-in-per-device** (the existing long/sliding `token_epoch` session — 2FA gates login, not every request) and **biometric keystore unlock** (Face ID / Touch ID wrapping the keystore key in Secure Enclave / Android Keystore) as the native "stay logged in" convenience. Full design in D7 §4. 2FA does NOT replace recovery — it can't return your keys (D7 §0).
- **Change password** (requires current password; re-encrypts the keystore + updates the server verifier + bumps `token_epoch`, atomically per D7).
- **Delete account** — wire the Settings danger-zone entry to the existing password-reauthed endpoint + local panic-wipe.
- **Forgot password + recovery code** — implement the D7 recovery-code protocol. It fixes the "anyone resets anyone" hole (reset requires proving possession of the recovery code) and is honest that no code + no password = unrecoverable by design. **Decided: server-stored opaque recovery blob** (recovery survives device loss; the blob is unreadable by the server). When 2FA is on, it also gates the recovery-blob fetch as defense in depth.
- **Up-front trust additions:** an About section (app version + build, "View source" link, links to the in-app transparency page, the threat model, and `security@flatfold.ponderance.dev`); onboarding that explains the two-lock model and the recovery-code choice with its honest warning.
- Update `/transparency` (`src/data/serverState.ts`), `THREAT_MODEL.md`, and the App Privacy label (D6) for the new stored fields: TOTP secret + backup-code hashes (for users who enable 2FA), the recovery verifier, and the opaque recovery blob. These enlarge the server's footprint — disclose them plainly; that honesty is the point.
- All of the above (2FA verify, keystore re-encryption, recovery wrap/unwrap, biometric wrap) is crypto-critical: constant-time checks, encrypted/hashed-at-rest secrets, rate limiting, and tests (valid/invalid/expired/replayed codes, single-use backup codes, wrap/unwrap round-trip, wrong-code failure) — same rigor as the ratchet.

## 5. Native builds — iOS, macOS, and Android, for the stores

- **Approach:** Capacitor wrapper that **bundles and signs the web assets and loads them locally** (never a remote URL, never an Android TWA — that would forfeit the security benefit and risk App Store 4.2 rejection). iOS + iPadOS are one universal binary; **macOS via Mac Catalyst** (or the Apple-silicon route); **Android** as a Capacitor app with bundled assets. Ship to the App Store and Google Play. (Windows/Linux via Tauri is out of scope for now.)
- **Per platform:** APNs (iOS/macOS) + FCM (Android) for content-free push; bearer-token auth for native (already seamed); secure storage — iOS/macOS Keychain (Secure Enclave-backed) and Android Keystore (StrongBox where available).
- **Automated release** (this is what keeps maintenance small): Fastlane `match` + the App Store Connect API key for signing/upload/submit; the Play Developer API for Android; GitHub Actions triggered on a `v*` tag builds, signs, and submits all targets. The same workflow runs `lint + test + build` on every PR, which also closes the audit's "no CI" finding.

## 6. Performance optimization (all three platforms)

- **Code-split the heavy paths** so first paint is lean: lazy-load `@hpke/core` + the sealed-sender path, the QR/camera scanner, and the `MediaRecorder` voice path.
- **Move heavy crypto off the main thread:** run Argon2id (keystore derivation) and bulk operations in a Web Worker so unlock and the keyboard never jank the UI thread — keeping keys inside the worker/secure context, not widening exposure.
- **Virtualize the message list** (audit finding): windowed rendering so long histories don't balloon DOM/memory on low-end devices.
- **Media:** thumbnails, off-thread decode, cap in-memory images, release object URLs.
- **Cold start:** minimal app shell, themed splash to avoid a bright flash before the UI (respect the active theme), rely on the integrity-pinned service worker for the shell.
- **WKWebView:** avoid keyboard layout thrash (`visualViewport`), passive scroll listeners, `overscroll-behavior: contain`. Profile on a real low-end device, not just the simulator.

## 7. Security optimization / hardening (security is still paramount)

- **Bundled, signed assets only** — the property that closes the web-client caveat. No remote app-shell on any platform.
- **TLS certificate/public-key pinning** on the native HTTP + WebSocket client, with a backup pin and a documented rotation path.
- **Keys in hardware:** keystore key (and the D7 recovery material) protected by Secure Enclave / Android Keystore; the recovery blob is opaque to the server.
- **App-switcher / screenshot privacy:** obscure the screen when the app is backgrounded so message content never shows in the app switcher or a screenshot.
- **Production hardening:** disable the web inspector in release builds; strip source maps from shipped assets; keep the bundled-context CSP tight (`script-src 'self' 'wasm-unsafe-eval'` is load-bearing for Argon2 — extend only deliberately).
- **Content-free push** preserved on APNs and FCM. **No third-party SDKs, analytics, trackers, or ad frameworks** — keep the dependency surface minimal, pinned, and audited.
- **Optional:** a soft jailbreak/root warning (don't hard-block). **Reproducible builds** documented and build hashes published — verifiability is the whole point.
- Re-run the security audit's checks against the native surfaces and update `THREAT_MODEL.md` / `/transparency` / the App Privacy label for anything new.

## 8. Verify (per platform, simulator AND a real device)

The zoom/keyboard/FAB class is gone; feature parity holds; change/forgot/delete work end-to-end including wrong-recovery-code failure; themes pass AA; push is content-free; cert pinning holds; the app-switcher view is obscured. Screenshots as evidence, never "looks fine in the browser."

## 9. Build order

1. Viewport/keyboard rules + tab-bar nav + list/chat/composer — verify the bug class is gone on-device first.
2. Feature-parity sweep (every web feature present and native-correct).
3. Account features + recovery (crypto-careful, tested; confirm the server-blob decision).
4. Themes + icon/splash + About.
5. Per-platform push + secure storage + cert pinning + app-switcher privacy.
6. Performance pass (code-split, virtualization, off-thread crypto).
7. Release pipelines for iOS/macOS/Android + store submissions (D5 copy, D6 privacy label, the demo account from the review notes).
