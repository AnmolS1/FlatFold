# Desktop shell — options paper

Written 2026-07-26, after the Mac Catalyst spike came back BLOCKED
(`spike/mac-catalyst`, commit `5bc798e`: Capacitor 8's SwiftPM distribution ships
no `maccatalyst` slice, so Catalyst cannot link at all). Research current as of
this date; Tauri moves fast, so re-check before committing.

This is a decision paper, not a recommendation to act today.

## VALIDATED 2026-07-26: Catalyst is NOT blocked by Capacitor's source

The earlier spike concluded "blocked". That was true of the SwiftPM
distribution and only of that: `Capacitor.xcframework` ships `ios-arm64` and
`ios-arm64_x86_64-simulator` and no `maccatalyst` slice, so it cannot link.
The conclusion was then generalised to "Catalyst is blocked", which is wrong.

Measured, by compiling the actual sources for `arm64-apple-ios15.0-macabi`
against the macOS SDK with `System/iOSSupport` on the framework path:

| target | Catalyst errors | iOS errors (control) |
| --- | --- | --- |
| Capacitor core (44 files) | 2 | 2 |
| @capacitor/app | 2 | 2 |
| @capacitor/haptics | 2 | 2 |
| @capacitor/share | 2 | 2 |
| @capacitor/filesystem | 0 | 0 |
| @capacitor/push-notifications | 2 | 2 |
| @capacitor/local-notifications | 2 | 2 |

**The delta is zero everywhere.** Every error is identical on both targets and
is an artifact of typechecking in isolation (an unbuilt `Capacitor` /
`CAPBridgedPlugin` import), not a Catalyst incompatibility. A scan for
Catalyst-unavailable APIs across Capacitor and CapacitorCordova found none.

The podspecs are SOURCE-based (`s.source_files = 'ios/Sources/**/*.swift'`), so
CocoaPods compiles rather than linking the prebuilt xcframework, and CocoaPods
1.16.2 is installed. Option B's premise holds.

**Still unproven**: that the app assembles, links, signs and launches as a
Catalyst app. This validates "the code compiles for Catalyst", which is the
question that made B look impossible — not the whole migration.

Why it is worth doing, beyond fixing bugs: Catalyst gives the real macOS
WKWebView, which exposes `navigator.mediaDevices`. That DELETES
`FlatFoldAudioPlugin` entirely (~280 lines of Swift plus its bridge transport,
finalize handling and audio-session juggling), and deletes the ghost-row hack in
MainViewController. The argument is code removal, not bug fixing.

## The finding that changes the shape of the question

**Tauri v2 does mobile.** It went stable on 2024-10-02 with iOS and Android
alongside desktop. So Tauri is not necessarily a *second* shell bolted next to
Capacitor — it could in principle replace it.

That is the strongest argument for it and also where the risk concentrates, so
it deserves care rather than enthusiasm. The Tauri team's own framing is that
they "don't want to raise expectations that Tauri 2.0 will be the *mobile as a
first class citizen* release," while stating you can ship production mobile apps
with it. Desktop is production-grade; mobile is stable-API but younger, and not
every desktop plugin exists on mobile.

## What Tauri is good at, for this app specifically

FlatFold's pitch is "the source is public and the server knows nothing," so the
shell's security posture is part of the product, not an implementation detail.

- **Default-deny capability model.** Commands, scopes and windows are allowed
  explicitly in JSON capability files; the WebView reaches the system only
  through a declared IPC surface. That is a materially better story than "a
  WebView with a bridge," which is what Capacitor is.
- **No bundled browser engine.** Uses the OS WebView, so no Chromium to patch.
  Smaller binaries and a smaller attack surface than Electron.
- **Rust core.** The privileged half of the app is memory-safe by default.

## The three gaps, in order of how much they should worry you

### 1. Secure storage is the real problem, and it is the thing you cannot get wrong

Today the master key lives in a Secure-Enclave-gated Keychain item with
`.biometryCurrentSet` and `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`,
through ~130 lines of Swift this project wrote and device-verified.

Tauri's **official** secret-storage answer is the **Stronghold** plugin — a
self-contained IOTA-derived encrypted vault. It is *not* an OS-keychain
integration: it does not delegate to macOS Keychain, Windows Credential Manager,
or Linux Secret Service. So adopting it means the master key stops being
protected by the Secure Enclave and starts being protected by a Rust vault
unlocked with a password hash. **That is a downgrade of the exact property
THREAT_MODEL leans on**, and it should not be waved through.

OS-keychain access does exist, but via **community plugins** —
`tauri-plugin-keyring`, `tauri-plugin-keystore`, `tauri-plugin-secure-element`,
plus an official `tauri-plugin-biometric` for the biometric prompt. These are
largely single-maintainer crates. For a messenger whose entire value is key
custody, depending on a single-maintainer crate for key custody is a
supply-chain decision, not a convenience one.

**This is the item that decides the whole question.** Everything else is work;
this is risk.

### 2. Three WebView engines, and your crypto is verified against two

Tauri uses WKWebView (macOS/iOS), WebView2/Chromium (Windows), and WebKitGTK
(Linux). FlatFold's stack — Argon2id WASM, `@hpke/core`, WebAuthn PRF — is
currently proven on WKWebView and Chromium only.

WebKitGTK is the unknown. Safari 18 added PRF, but I found **no clear evidence of
WebAuthn PRF in WebKitGTK**, and Linux platform authenticators are uncommon in
the standard stack regardless. Practical consequence: **passkey unlock would be
macOS/Windows only at first**, with Linux falling back to password-only. That is
survivable — the password is the ultimate secret by design — but it must be a
stated limitation, not a surprise.

Argon2 WASM on WebKitGTK is also unverified. Given this project has already been
bitten by WASM CSP behaviour in WKWebView, assume a spike is needed, not a port.

### 3. No push, at all

No APNs, no FCM. Desktop notifications work only while the app runs; there is no
wake-up for a closed app. FlatFold's notifications are already content-free
wake-ups, so the loss is smaller here than for most apps — but on desktop it
means "you find out when you open it." That is a product decision.

## What I could not verify

- **No recent formal third-party security audit surfaced** in this research. That
  is not evidence of absence, and Tauri's own security documentation is unusually
  thorough. But if the shell's security posture is going to be load-bearing in
  the threat model, "audited" should be confirmed rather than assumed.
- Whether Tauri mobile can carry this app's native surface — APNs registration,
  a Secure-Enclave biometric plugin, `NSPinnedDomains` TLS pinning, alternate app
  icons, the app-switcher privacy overlay. Each exists as bespoke Swift today.

## The options, honestly stated

| | effort | what you get | what you risk |
|---|---|---|---|
| **A. Stay on passthrough** | none | macOS today, iOS unchanged | no mic; a Mac experience you already judged poor |
| **B. Capacitor -> CocoaPods, then Catalyst** | medium-high | a real Mac app, iOS untouched in behaviour | migrating a shipping app's build system; the podspec is iOS-only today so Catalyst support must be added to it |
| **C. Tauri desktop, Capacitor stays on mobile** | high | macOS + Windows + Linux | two native shells to maintain forever; secure storage rebuilt for desktop |
| **D. Tauri everywhere, drop Capacitor** | very high | one shell, five platforms | rewrites the entire native layer, including key custody, on a stack whose mobile half is younger |
| **E. Descope desktop** | none | closes FULL_AUDIT_2 P2 honestly | no Mac app |

## My reading

**B or E, not C or D — for now.**

The instinct behind "Tauri is the most available" is right, and if you were
starting today it would be a strong default. But you are not starting today: you
have a shipped iOS app with a device-verified Secure Enclave key custody path, a
working APNs pipeline, TLS pinning proven with both controls, and an App Store
submission nearly ready. Options C and D put the *most security-critical
component you own* onto a community plugin, in exchange for platforms you have
no users on yet.

**B is the smaller bet** — it keeps key custody exactly where it is and only
changes how Capacitor is built. It should be validated cheaply first: check
whether Capacitor's CocoaPods distribution can even target Catalyst before
committing to the migration. If it cannot, B collapses and the real choice is E
now / D later.

**E is not a failure.** "iOS and web today, desktop when there is demand" is a
defensible public position, and it closes the audit item honestly rather than
leaving the docs implying a Mac app is coming.

Whichever way it goes, decide it on the secure-storage question first. That is
the one that is expensive to reverse.

## Sources

- [Tauri 2.0 Stable Release](https://v2.tauri.app/blog/tauri-20/)
- [Tauri (software framework) — Wikipedia](https://en.wikipedia.org/wiki/Tauri_(software_framework))
- [Tauri Security](https://v2.tauri.app/security/) and [Capabilities](https://v2.tauri.app/security/capabilities/)
- [Stronghold plugin](https://v2.tauri.app/plugin/stronghold/)
- [tauri-plugin-keyring](https://github.com/charlesportwoodii/tauri-plugin-keyring), [tauri-plugin-keystore](https://github.com/impierce/tauri-plugin-keystore), [tauri-plugin-secure-element](https://github.com/dkackman/tauri-plugin-secure-element), [tauri-plugin-biometric](https://crates.io/crates/tauri-plugin-biometric)
- [Passkeys & WebAuthn PRF for End-to-End Encryption](https://www.corbado.com/blog/passkeys-prf-webauthn), [WebAuthn PRF explainer](https://github.com/w3c/webauthn/wiki/Explainer:-PRF-extension)
