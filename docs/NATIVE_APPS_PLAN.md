# FlatFold native apps — evaluation, plan, and automation design

Status: **decision made — go**, conditionally, and the conditions are met. This doc is the plan, the security requirements, and the automation design that keeps the ongoing work small. Nothing is built yet.

## The decision, and why

Native apps are worth building **because they close FlatFold's single biggest documented residual** — the web-client caveat (the same server that relays your ciphertext ships the JS that encrypts it). The threat model and `/transparency` both already tell users that if their adversary is the server, they should use a client they can verify. A signed, locally-bundled native app *is* that client. This is a real security advance, not a vanity feature — which matters because the whole point of the app is to be as secure as possible.

Two conditions had to hold, and both do:

1. **The security win has to be real.** It is, but only under one hard rule (below): bundle and sign the assets, don't wrap a remote URL.
2. **The ongoing maintenance has to be mostly automatable.** It is — see the automation section. With the App Store Connect API key already in hand, releases become close to one command.

If either failed, the answer would be "stay web-only / PWA." They don't, so: go.

## The one hard rule

**The app ships the built web assets inside the signed binary and loads them locally (`capacitor://` / `file://`). It never loads the app shell from `https://flatfold.ponderance.dev`.** Only API and WebSocket traffic goes to the server.

- Bundled + signed = the code is reviewed and signed once (at store submission), not re-shipped every launch. That is exactly what a browser can't promise and what closes the caveat.
- A thin wrapper that loads the live URL, or an Android **TWA** (which loads the site in Chrome), gains **zero** security — the server still ships the code each launch — and risks App Store rejection under guideline 4.2 ("minimum functionality / just a website"). So TWA and remote-webview are both off the table for the security goal, even though they're cheaper.

## Approach: wrapper, not rewrite

Reuse the entire audited web app (React UI + the `@noble`/`@hpke`/WebCrypto crypto + the keystore) inside a native shell. **Do not** reimplement the crypto natively — that would put X3DH, the Double Ratchet, and sender-keys into Swift *and* Kotlin, tripling the security-critical surface and the audit burden for no user benefit. The crypto runs in the platform web engine exactly as it does today.

Platform mapping (your list, corrected):

- **iOS + iPadOS** — one universal Capacitor app. iPad is not a separate target.
- **macOS** — comes off the iOS app via **Mac Catalyst**, or the automatic "iOS apps on Apple Silicon" route. Low incremental cost once iOS exists. (A separate Tauri desktop build is only worth it if you want Windows/Linux too.)
- **Android** — a Capacitor app with **bundled assets** (not a TWA).
- **Windows/Linux** — optional, via **Tauri**, only if desktop-beyond-Mac matters. Decide later.
- **Web** — stays as-is, and stays honestly caveated.

Tooling: **Capacitor** for iOS/Android (wraps the existing Vite build, has first-class plugins for push, secure storage, and app lifecycle). Consider **Tauri** only for the Win/Linux desktop case.

## Security requirements (the heart of this — native must be *more* secure than web, not less)

1. **Bundled, signed assets** (the hard rule above). This is the whole point.
2. **TLS certificate/public-key pinning** on the native HTTP + WebSocket client to the API. A native app can pin the server key; a browser effectively can't. Pin with a backup key and a documented rotation path so a legitimate cert roll doesn't brick clients.
3. **Keystore key in hardware-backed storage.** Move the Argon2id-derived keystore key (or a wrapping key for it) into the **iOS Keychain (Secure Enclave-backed)** and **Android Keystore (StrongBox where available)**, instead of it living only in the web engine's memory / IndexedDB. Native-only upgrade to key-at-rest protection.
4. **Reproducible, verifiable builds.** The app is AGPL and open-source, so an auditor can rebuild the `.ipa`/`.aab` and diff it against a release. This is what makes "a client you can verify" true in practice, not just in principle. Pin the toolchain (Node, Capacitor, Xcode/Gradle versions), commit lockfiles, and document the exact rebuild recipe. Publish the expected build hashes alongside each release.
5. **Content-free push preserved.** The new APNs/FCM path must keep the existing invariant: the push payload carries no message text and no sender, just a "wake up and sync" signal. Same as Web Push today.
6. **Token auth handled as carefully as the cookie path.** The native bearer-token (below) must respect the existing `token_epoch` revocation, ride only over pinned TLS, and be stored in secure storage — never in plaintext prefs.
7. **Update the honesty surfaces when native ships.** Amend the threat model and `/transparency`: native clients close the web-client caveat (signed + reproducible + open-source), while the web client remains caveated. Keep the two distinct and accurate.
8. **App Store encryption compliance.** Declare `ITSAppUsesNonExemptEncryption` and file the standard export-compliance answer (standard E2E crypto generally qualifies for the exemption, but it must be declared). One-time, routine.

## Backend legwork (the real work, and it's bounded)

The crypto needs nothing. Three server-side / transport changes:

- **Token auth for native clients.** Today auth is a `SameSite=Strict` cookie, chosen because a *browser* WebSocket can't set an `Authorization` header (`worker/auth.ts` says so). Native clients *can* set headers, so add a bearer-token path: issue the same signed, epoch-stamped token, accept it via `Authorization` on `/api/*` and the `/ws` upgrade, keep the cookie path for web. The token model already exists (`token_epoch`, sliding refresh); this is a second delivery channel for it, not a new auth system.
- **APNs + native FCM push.** `worker/push.ts` speaks Web Push/VAPID today (and its allowlist already includes `push.apple.com`/`fcm.googleapis.com` for the web path). iOS `WKWebView` does **not** support Web Push, so native iOS needs an **APNs** path; native Android uses **FCM** directly. Add these as parallel senders keyed by subscription type, preserving the content-free payload. This is the biggest single piece of backend work.
- **Secure-storage bridge (client-side).** A small Capacitor plugin integration to stash the keystore key in Keychain/Android Keystore. Backend-neutral.

Everything else — the mailbox DO, D1 schema, sealed sender, media — is unchanged.

## Automation: making the ongoing work near-zero

This is the part that makes it feasible for a solo dev. Target end state: **push a git tag, both stores get a signed, submitted build.**

Automatable (do all of it):

- **Signing** — Fastlane **`match`** stores certs + provisioning profiles in an encrypted git repo; combined with your **App Store Connect API key**, there's no manual cert wrangling and no 2FA prompts in CI.
- **Build + wrap** — GitHub Actions runs `vite build` → `cap sync` → native build, producing signed `.ipa` / `.aab` / Catalyst `.app`.
- **Upload + submit** — Fastlane **`pilot`** (TestFlight) and **`deliver`** (App Store) via the API key; **Play Developer API** (via Fastlane `supply` or the Gradle Play Publisher) for Android. Auto-submit for review.
- **Metadata, screenshots, version/build bumps, changelog** — scripted and committed, so they're diffable, not click-ops.
- **Push infra** — once the APNs key and FCM credentials are CI secrets, there's no recurring manual step.
- **The audit's CI gap closes for free** — the same pipeline runs `lint + test + build` on every PR, which is the "no CI" finding from `FULL_AUDIT.md` §9. One pipeline, two wins.

Honestly *not* automatable (so you know the real residual):

- **Apple review is a human gate** (hours–days). You can auto-submit, not auto-approve; a rejection needs a human reply now and then. Android review is faster and mostly automated.
- **One-time setup**: creating app records, agreeing to Apple's legal/tax/banking, first-time cert/key generation, the export-compliance declaration. Done once.
- **Periodic policy nudges**: e.g. "target Android API N by date X," or an occasional SDK deadline. Rare, low-effort with a wrapper, and CI makes the rebuild trivial.

Net: after setup, your per-release manual work is tagging a release and, occasionally, answering a reviewer. That's the "minimize the work I actually do" outcome you asked for. Reuse your existing `apps-and-widgets` publishing playbook and the FlatFold per-app notes there so this isn't greenfield.

## Phased roadmap

Each phase ends with a security review against the requirements above before moving on.

- **Phase 0 — Spike (small).** Add Capacitor to the repo, get the bundled web app running in the iOS simulator loading local assets (not the live URL). Prove the crypto + keystore work unchanged in `WKWebView`. This de-risks the whole thing cheaply; if `WKWebView` chokes on the WASM/Argon2 path, we learn it here.
- **Phase 1 — iOS to TestFlight.** Token auth on the backend; APNs push; Keychain key storage; cert pinning. Fastlane `match` + API-key pipeline in GitHub Actions → TestFlight on tag. Internal testing.
- **Phase 2 — Android.** Capacitor Android with bundled assets; FCM push; Android Keystore; Play Developer API pipeline → internal track on tag.
- **Phase 3 — macOS.** Mac Catalyst off the iOS target (or the Apple-Silicon route), same pipeline.
- **Phase 4 — Store launch + honesty update.** App Store / Play production submission, reproducible-build recipe published, threat model + `/transparency` updated to distinguish native (caveat closed) from web (caveat stands). Optional Tauri desktop if Windows/Linux is wanted.

Suggested order matches your runway: iOS first (you have the account, the API key, and the playbook), Android second, macOS as a near-free follow-on.

## Open decisions for you

1. **Desktop scope:** macOS-only (Catalyst, near-free from iOS), or Windows/Linux too (adds a Tauri track)? Affects Phase 3+.
2. **Distribution model:** free on both stores, as now? (No IAP means simpler review and no Apple financial/tax setup beyond the free-app agreement.)
3. **Bundle IDs / naming:** reuse the `ponderance` app family conventions from `apps-and-widgets`, or a standalone FlatFold identity?
4. **Push provider on Android:** FCM is the default and simplest; if you'd rather avoid Google entirely on principle (it's a privacy app), there's a more complex self-hosted/UnifiedPush path worth a separate conversation. Flagging because it's philosophically on-brand even if it's more work.

Once you pick on #1 and #4 especially, Phase 0 is a small, self-contained spike I can turn into a Claude Code prompt.
