# FlatFold native apps — Phase 1–4 execution notes (for me, next sessions)

Companion to `docs/NATIVE_APPS_PLAN.md` (the decision + design) and
`docs/NATIVE_SPIKE_FINDINGS.md` (Phase 0 = GREEN). This is the working memo I
execute from. Phase 0 is done; everything below is not built yet.

## Decisions locked with Anmol (2026-07-21)

1. **Desktop scope:** iOS + Android + macOS **and Windows/Linux via Tauri.**
   So a Tauri desktop track IS in scope (Phase 3/4), not just Catalyst.
2. **Distribution:** **Free, no IAP** on both stores. No Apple financial/tax
   setup beyond the free-app agreement; no StoreKit.
3. **Android push:** **UnifiedPush / self-hosted — NOT FCM.** Avoids Google on
   principle (on-brand for a privacy app). Bigger Phase 2 lift: needs a
   distributor. Natural fit = self-hosted **ntfy** on the ponderance homelab as
   the UnifiedPush distributor (ntfy speaks UnifiedPush). Design the push sender
   to be provider-abstract so APNs (iOS) + UnifiedPush (Android) + existing Web
   Push (PWA) are parallel senders keyed by subscription type.
4. **Bundle ID / identity — DECIDED + REGISTERED (2026-07-21): `dev.flatfold`**
   (standalone, Anmol's preference; `dev.ponderance.flatfold` was the fallback
   if taken, but `dev.flatfold` was available). Registered via the ASC API
   (`POST /v1/bundleIds`, platform IOS — covers Mac Catalyst later); ASC
   resource id `ZVNWT69U94`. So `capacitor.config.ts` `appId` = `dev.flatfold`
   for the Phase 1 iOS scaffold (Phase 0 used the placeholder
   `dev.ponderance.flatfold` — change it). ASC API key lives at
   `./AuthKey_2MDZ3YJRLG.p8` (gitignored via `*.p8`); its Key ID + Issuer ID
   are known to Anmol / stored with the key, NOT in this repo. The key has the
   role to create Bundle IDs, so it can likely also drive Fastlane
   `match`/`pilot`/`deliver` in the Phase 1 pipeline (verify its exact role).

## Apple account context (from shared memory `topics/apple-distribution.md`)

- Team **G2KBQH7KWT**. **This Mac CANNOT distribute** (Organizer-only); real
  archive/upload must go through **Xcode Cloud** (`ci_post_clone` regenerates
  generated files) or a CI runner. Plan the TestFlight pipeline around CI, not
  local `xcodebuild archive`.
- Anmol already has an **App Store Connect API key** (per the plan) — enables
  Fastlane `match`/`pilot`/`deliver` with no 2FA in CI.
- Read `topics/apple-distribution.md`, `topics/ios-project-setup.md`,
  `topics/ios-xcodegen-build.md`, and `topics/capacitor-wkwebview.md` (new)
  before starting Phase 1. Screenshot sizes + `ITSAppUsesNonExemptEncryption`
  live in those.

## Phase 0 carry-overs (facts I proved, reuse them)

- **Capacitor 8 = SwiftPM**, no CocoaPods. Scaffold already exists on
  `spike/capacitor-ios` (`ios/`, `capacitor.config.ts` with NO `server.url`,
  `webDir: dist/client`). Phase 1 can start from a clean re-scaffold OR reuse
  that ios/ dir; either way DELETE `src/spike/SpikeHarness.tsx` + its App.tsx
  mount (already unmounted) — it must never ship.
- **Bundled-context CSP (must ship as a meta tag in index.html — `_headers`
  does NOT apply to local assets):**
  ```
  default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self';
  style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:;
  font-src 'self'; connect-src 'self' https://flatfold.ponderance.dev
  wss://flatfold.ponderance.dev; manifest-src 'self'; frame-ancestors 'none';
  base-uri 'none'; form-action 'self'; object-src 'none'
  ```
  `'wasm-unsafe-eval'` is REQUIRED (Argon2id) and proven load-bearing. Drop the
  `'unsafe-inline'` the spike used for style — that was a harness artifact.
  Inject for the native bundle only (build step); web keeps `_headers`.
- Argon2id runs ~80 ms in WKWebView; IndexedDB persists across quit; crypto
  path is fully validated. No native crypto rewrite — the plan's hard rule.

## Phase 1 — iOS to TestFlight (the big one). Backend + native + pipeline.

**Backend (worker/):**
- **Token auth for native.** Today `worker/auth.ts` = `SameSite=Strict` cookie
  (chosen because browser WS can't set headers). Native CAN set headers. Add a
  bearer-token path: issue the SAME signed, `token_epoch`-stamped token, accept
  it via `Authorization` on `/api/*` AND the `/ws` upgrade; keep the cookie path
  for web. Reuse the existing token model (`token_epoch`, sliding refresh) — new
  delivery channel, not new auth. Files: `worker/auth.ts`, the `/ws` upgrade in
  `worker/index.ts`.
- **CORS for `capacitor://localhost`** on `/api/*` (preflight) — native-only,
  do NOT loosen the web same-origin posture. This is why cross-site cookie auth
  is dead from `capacitor://` (Phase 0 finding) and the token path is mandatory.
- **Client:** `src/lib/api.ts` uses RELATIVE URLs + `credentials:'include'`.
  Native needs an absolute API base (env/config) + `Authorization` header +
  token in secure storage. Add a build-time flag distinguishing web vs native.
- **New secret if any (e.g. token-signing already exists as SESSION_SECRET):**
  declare it in `worker/env-secrets.d.ts` (see the CI-hermetic fix, commit
  `bda2637`) or CI's `tsc` breaks on a fresh clone.

**Push (APNs, iOS):** `worker/push.ts` speaks Web Push/VAPID; its allowlist
already includes `push.apple.com`. Add an APNs sender keyed by subscription
type, **content-free payload preserved** (wake-and-sync only, no text/sender).
APNs key → CI secret. (Android UnifiedPush is Phase 2 — build the sender
abstraction now so both slot in.)

**Native security upgrades:**
- **Keychain** (Secure Enclave-backed) for the Argon2-derived keystore key (or
  a wrapping key). Today it lives in `sessionStorage` (per-tab). A Capacitor
  secure-storage plugin bridges it. Backend-neutral.
- **TLS cert/public-key pinning** on the native HTTP + WS client to the API.
  Pin WITH a backup key + documented rotation path so a legit cert roll doesn't
  brick clients.

**Pipeline (automation — the whole point of feasibility):**
- Fastlane **`match`** (certs/profiles in an encrypted git repo) + the ASC API
  key → no manual cert wrangling, no 2FA in CI.
- GitHub Actions: `vite build` → inject native CSP → `cap sync` → native build →
  Fastlane `pilot` → TestFlight **on git tag**. This ALSO satisfies the audit's
  lint+test+build-on-PR (already have `ci.yml`; extend it).
- **Reproducible builds:** pin Node/Capacitor/Xcode versions, commit lockfiles,
  document the rebuild recipe, publish expected `.ipa` hashes per release. This
  is what makes "a client you can verify" true (AGPL + open source).

**Phase 1 exit:** security review vs the plan's 8 requirements before Phase 2.

## Phase 2 — Android (Capacitor, bundled assets, NOT a TWA)

- Capacitor Android with **bundled assets** (Chromium WebView — expected to be
  fine; iOS was the gated risk and it passed).
- **UnifiedPush** (self-hosted ntfy distributor), NOT FCM (decision 3). More
  work: stand up/point at an ntfy instance, integrate the UnifiedPush client,
  parallel sender in `worker/push.ts`. Content-free payload preserved.
- **Android Keystore** (StrongBox where available) for the keystore key.
- Play Developer API pipeline (Fastlane `supply` or Gradle Play Publisher) →
  internal track on tag. NOTE: no Google FCM, but Play Store distribution still
  uses a Google Play dev account — that's separate from the push decision.

## Phase 3 — macOS (Catalyst) + desktop (Tauri, per decision 1)

- **macOS via Mac Catalyst** off the iOS target (or Apple-Silicon "iOS apps on
  Mac" route) — near-free, same pipeline.
- **Tauri track for Windows/Linux** (decision 1 = yes). Separate build; reuse
  the same `dist/client` web bundle. Tauri has its own signing/updater story —
  research when we get there. Pin toolchain for reproducibility here too.

## Phase 4 — Store launch + honesty update

- App Store + Play production submission; Tauri desktop releases.
- **Publish the reproducible-build recipe + hashes.**
- **Update honesty surfaces:** amend `docs/THREAT_MODEL.md` and `/transparency`
  (`src/pages/Transparency.tsx` + `src/data/serverState.ts`) to distinguish
  NATIVE clients (web-client caveat CLOSED — signed + reproducible + open source)
  from WEB (caveat still stands). Keep the two distinct and accurate. There's a
  schema-drift test guarding serverState — expect it to bite; update together.
- `ITSAppUsesNonExemptEncryption` + export-compliance declaration (one-time,
  standard E2E-crypto exemption, but must be declared).

## Cross-cutting reminders

- **Deploy footgun (from prod incidents):** `@cloudflare/vite-plugin` picks env
  at BUILD time — `CLOUDFLARE_ENV=preview npm run build`, and CHECK
  `dist/flatfold/wrangler.json` `name`/`routes: []` before `wrangler deploy` or a
  named env hijacks the prod custom domain. See `topics/cloudflare-workers.md`.
- **ponderance repo:** the FlatFold legal-registry commit `10fca6c` is on
  `origin/dev`; the login footer's Privacy/Terms links won't SHOW FlatFold until
  ponderance's prod deploys. Separate repo, separate deploy. Uncommitted local
  changes there (`legal-services.ts`, `CLAUDE.md`) were left untouched.
- **Milestone cadence:** Anmol wants a check-in between phases (each phase ends
  with a security review vs the plan's requirements). Call `advisor()` before
  declaring any phase done and before the honesty-surface edits.
- Spike branch `spike/capacitor-ios` (`f792206`) is throwaway — delete once
  Phase 1 starts clean.
