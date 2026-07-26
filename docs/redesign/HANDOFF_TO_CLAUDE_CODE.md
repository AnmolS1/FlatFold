# FlatFold native redesign — start here (Claude Code entry point)

Everything for the native redesign + builds lives in `docs/redesign/`. Read in this order, then execute the build prompt.

## Read first
1. `NATIVE_BUILD_PROMPT.md` — the master build order. Everything below supports it.
2. The §3 hard constraints (crypto/backend off-limits, reuse the live seams, keep web working, a11y) — restated in full under "Hard constraints" in `HANDOFF_STEP6_CONTINUATION.md`. (The original mandate doc that stated them has been deleted as a spent prompt.)
3. `D2_interaction_spec.md` — per-screen native behavior + the global rules that kill the zoom/keyboard/FAB bug class.
4. `D3_themes.md` — the five themes as token tables (all WCAG-AA verified).
5. `D4_icon_and_splash.md` — icon/splash placement.
6. `D5_appstore_copy.md` + `D5b_play_store_copy.md` — App Store + Play copy, review notes, Data Safety.
7. `D6_app_privacy_label.md` — Apple App Privacy answers.
8. `D7_account_recovery_design.md` — 2FA, change/forgot password, recovery, biometric unlock. Crypto-critical.
9. `D1_native_directions.md` — context for the chosen direction.

Mockups (the concrete UI targets, produced in Cowork): conversation list + tab bar, chat + composer, settings, 2FA login, recovery-code setup, forgot-password entry. Brand assets in `../../brand/`: `flatfold-app-icon-1024.png` (iOS, opaque), `flatfold-android-icon-maskable-1024.png` + `flatfold-play-listing-512.png` (Android), `flatfold-splash-*`.

## Decisions already made (don't re-litigate)
- **Design:** Direction C (dense, gesture-forward) + bottom tab bar (Chats / Contacts / Settings).
- **Themes:** the five in D3 (Paper, Ink, Vellum, Graphite, Midnight Crane), default to OS.
- **Recovery:** server-stored opaque recovery blob (D7).
- **2FA:** standard TOTP (RFC 6238), optional, for login; not a vendor. Plus biometric keystore unlock.
- **Platforms:** iOS, iPadOS (one binary), macOS (Catalyst), Android (Capacitor, bundled assets) — App Store + Play.

## Needs Anmol at the right moment (don't block early work on these)
- The review **demo account** credentials (create on the live backend; fill into D5 review notes).
- Sign-off on the **E2E-content-not-collected** privacy position + the **privacy-policy URL** (D6 / D5b Data Safety).

## Non-negotiables
- Bundle + sign the web assets; never load the app shell from a remote URL (that forfeits the whole security point).
- The account/2FA/recovery/keystore work is crypto-critical: tests + self-review, same rigor as the ratchet. Everything else presentational.
- Verify on the simulator AND a real device per platform (screenshots), not the browser.

## Build order (from the master prompt)
1. Global viewport/keyboard rules + tab-bar nav + list/chat/composer — verify the bug class is gone on-device first.
2. Feature-parity sweep — the native apps do everything the web does (message, groups, media, voice, disappearing, verify+QR, contact add/remove, delete account, panic wipe, search, decoy label, sign out / sign out everywhere, themes, push).
3. Account features + 2FA + recovery (crypto-careful, tested); update `/transparency`, `THREAT_MODEL.md`, App Privacy/Data Safety for the new stored fields.
4. Themes + icon/splash + About.
5. Per-platform push (APNs/FCM, content-free) + secure storage (Keychain/Keystore) + TLS cert pinning + app-switcher privacy.
6. Performance pass (code-split heavy paths, virtualize the message list, Argon2 off-thread).
7. Release pipelines (Fastlane + App Store Connect API + Play Developer API + GitHub Actions on tag; also runs lint/test/build on PRs) + store submissions.
