# macOS target — findings and plan

Written 2026-07-25 from reading the code, not the plan docs. Answers FULL_AUDIT_2
P2 for the macOS half. Nothing here has been started.

**Headline: the biggest obstacle to a good Mac app is not macOS.** It is a
layout dead-end above 900px that already ships on iPad, and Catalyst inherits it
unchanged. Fix that first; it needs no Mac and no Xcode.

## Decision taken (2026-07-25): Mac Catalyst

The Apple-Silicon passthrough was tried on a real Mac and rejected — the UX is
poor, Settings is unreachable, and there are numerous other problems. So Catalyst
it is. What follows is rewritten around that.

For the record, the state Catalyst starts from: `TARGETED_DEVICE_FAMILY = "1,2"`,
`SDKROOT = iphoneos`, **no `SUPPORTS_MACCATALYST` anywhere**, and no macOS action
in CI (`ios-release.yml` runs on `macos-15`, but builds iOS only).

## Read this before writing any Catalyst code

**Most of what made the passthrough bad is not the passthrough. It is the web
layout above 900px, and Catalyst inherits every bit of it** — same Vite bundle,
same viewport width, same `isNativePlatform() === true`. Enabling a Catalyst
target and expecting the UX to improve would burn days and land in the same
place.

The reported "there's no settings" is not vague; it is a specific, traceable
dead-end in `src/pages/Chat.tsx`:

| line | code | effect |
|---|---|---|
| 1370 | `{!native && (` … Settings button `)}` | the header Settings button is hidden on native |
| 1659 | `{native && mobileView === 'list' && … <TabBar/>}` | the tab bar — the ONLY native route to Settings — needs `mobileView === 'list'` |
| 1417/1472 | `min-[900px]:flex` | at ≥900px BOTH panes render regardless of `mobileView` |
| 1480/1568 | `min-[900px]:hidden` on the back buttons | at ≥900px there is no control that sets `mobileView` back to `'list'` |

So: native, window ≥900px, open any conversation → `mobileView` becomes
`'conversation'` → the tab bar disappears, the back button is hidden, the header
button is hidden on native, **and Settings is unreachable with no way back**.
Verified by enumeration: `setSettingsOpen(true)` has exactly two call sites
(1372, 1664) and `setMobileView('list')` has exactly two user-triggered ones
(1479, 1567), both `min-[900px]:hidden`.

The root cause is a category error: `mobileView` is *phone navigation state*
being used to gate chrome in a layout where the phone navigation model does not
apply. Above 900px there is no "which pane am I on" — both are on screen.

### This is a shipping iPad bug, today

The same conditions are met by **iPad in landscape**, which the current App Store
build already supports (universal, `TARGETED_DEVICE_FAMILY = "1,2"`). iPad mini
landscape is 1024pt, 10.9" is 1180, Pro 11" is 1194 — all over the breakpoint.
Portrait on the smaller iPads is under 900, which is why nobody hit it: the app
works, you rotate, and Settings vanishes until you rotate back.

It is the same shape as the unlock-gate trap fixed earlier in this audit round —
a state with no exit — and it deserves the same treatment: a test that is watched
failing first.

**Fix this before Catalyst, not during.** It is required for Catalyst regardless,
it fixes a shipping iPad defect, and it is testable in jsdom today with no Mac,
no Xcode, and no new target. It also converts "the Mac UX is bad" from an opinion
into a list.

### The design decision — taken

**Header glyph on wide native**, for a desktop-like experience: `!native` became
`!native || wide`, and the tab bar became phone-only. The alternative (keep the
tab bar at all widths) was rejected as the more phone-shaped answer.

## The five Catalyst-specific things that will cost time

These are from reading the actual native code, not from the plan docs. Each is a
thing that *will* be wrong on day one, not a thing that might be.

1. **The privacy overlay will flash constantly.** `AppDelegate.swift:20` hangs
   `showPrivacyOverlay()` on `applicationWillResignActive`. On iOS that fires
   when you go to the app switcher — exactly right, and it is THREAT_MODEL
   residual #23. On a Mac it fires **every time the window loses focus**, so the
   app would cover itself whenever you clicked another window. Needs
   `#if targetEnvironment(macCatalyst)` with a different trigger, and a decision
   about whether the underlying threat (a screenshot of your chat) even applies
   the same way on macOS.

2. **The app-icon picker silently dies.** `FlatFoldAppIconPlugin.swift:20` gates
   on `UIApplication.shared.supportsAlternateIcons`, which is **false on
   Catalyst**. The plugin degrades gracefully (the section self-hides), so this
   is not a crash — but a whole D4 feature vanishes on Mac, and that should be a
   decision rather than a discovery.

3. **Biometric unlock is a maybe, not a given.** `FlatFoldBiometricPlugin.swift`
   stores the master key under `.biometryCurrentSet` +
   `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`. Many Macs have no Touch ID
   at all (Intel, or an external keyboard). The plugin already checks
   `canEvaluatePolicy` and reports `available:false`, so the UI should self-hide
   correctly — but *that path has never been exercised*, and macOS Keychain
   semantics for those two flags differ from iOS. Verify on hardware; do not
   assume the iOS behaviour carries.

4. **TLS pinning is unproven on macOS.** `NSPinnedDomains` is in `Info.plist` and
   was proven on iOS **with both controls** — a deliberately wrong pin that
   failed, then the real pins that succeeded. Whether ATS pinning behaves
   identically under Catalyst is an open question. `TLS_PINNING.md`'s own
   discipline says prove it, and a passing happy path proves nothing here,
   because a pin that matches everything also lets the app work.

5. **Capacitor 8 does not officially support Catalyst.** Treat it as a spike with
   a real chance of WKWebView configuration divergence, not as a build-flag
   change. The `capacitor://localhost` scheme handler, the injected CSP with
   `wasm-unsafe-eval`, and the bearer-token auth path all need re-verifying in
   that context — those three are precisely where this project has lost the most
   debugging time before.

Plus one that is cheap but easy to forget: **APNs needs its own macOS
provisioning profile and entitlement**, and this project has already been bitten
once by the sandbox-vs-production key selection.

## What will NOT be a problem (checked, so nobody re-derives it)

- **The web bundle is identical.** Same Vite output, same CSP injection, same
  `wasm-unsafe-eval`, same bearer-token auth. No second build pipeline.
- **`@capacitor/keyboard` is inert on a Mac** — no on-screen keyboard, so the
  `keyboardWillShow` listeners simply never fire and `--keyboard-height` stays 0.
  Harmless, not a bug to chase.
- **The xcodegen / Xcode Cloud `ci_post_clone` regeneration caveat does not apply
  here.** That bites `homelab-glance` and `calque`, whose `.xcodeproj` is
  generated and gitignored. FlatFold's `ios/App/App.xcodeproj` is
  Capacitor-generated and **tracked in git** (`git ls-files` confirms), so there
  is nothing to regenerate. Do not import that fix from memory.
- **The theme work just landed is resolution-independent** and needs no macOS
  pass — though the layout does, at window sizes a phone never sees.

## The constraint on any release path

**This Mac's CLI cannot distribute** — Apple Development cert only, zero
provisioning profiles; distribution goes through Xcode Organizer against the
signed-in paid account (team `G2KBQH7KWT`). For Catalyst that means either a manual
Organizer step per release, or an Xcode Cloud workflow. `homelab-glance` already
runs an `Archive - macOS` action in Xcode Cloud — read that before designing a
new pipeline, because it is the same account and the same constraint.

Note the existing `ios-release.yml` runs on `macos-15` but builds **iOS only**;
there is no macOS action anywhere in CI today.

## Proposed sequence

**Phase 0 — fix the ≥900px dead-end. DONE 2026-07-25 (commit `f6f139a`).**
Chose the desktop-like answer: the header Settings glyph returns once the window
is wide, and the tab bar becomes phone-only. Rules moved to `src/lib/chatChrome.ts`
as predicates; `test-ui/chatChrome.test.ts` walks all 48 states and was watched
failing first (4 trapped states, all `native/wide/conversation/*`). Also caught a
second dead end the fix would have created — the native Contacts pane opens only
from the tab bar, so hiding the tab bar on wide needed `showContactsPane` to fall
through to the ordinary contact list.
**Still unverified on hardware:** nobody has watched it render at a wide viewport.

**Phase 0b — audit the rest of the ≥900px layout while you are in there.**
The "dozen other issues" from the passthrough are very likely more of the same
class. Enumerate them at 1280×800 and 1512×982 in a browser (no Xcode required —
this is the same bundle) and decide which are real. Cheapest possible way to find
out what a Mac build actually needs.

**Phase 1 — Catalyst spike. DONE 2026-07-26. RESULT: BLOCKED.**
Branch `spike/mac-catalyst`, commit `5bc798e`. Catalyst cannot be built at all
with the current stack, and none of the five risks below were even reached.

`SUPPORTS_MACCATALYST=YES` has to be a real project setting (a CLI override does
nothing — the destination list is derived from the project). With it set, the
Catalyst destination appears and the build then fails identically in all 15+
targets:

    error: While building for Mac Catalyst, no library for this platform was
    found in '.../capacitor-swift-pm/Capacitor/Capacitor.xcframework'

Confirmed at the binary: that xcframework's Info.plist declares exactly two
slices, `ios-arm64` and `ios-arm64_x86_64-simulator`. **There is no
`ios-arm64-maccatalyst`.** Capacitor 8's SwiftPM distribution is prebuilt, so no
build setting can conjure the missing slice. (This is also why the SPM checkout
has no Swift sources to read — it ships `build-cap`/`package-cap` binaries.)

**The one possible path out, not attempted:** `@capacitor/ios` in node_modules
also ships `Capacitor.podspec` and 36 Swift source files, so the CocoaPods
distribution builds Capacitor FROM SOURCE. That could in principle target
Catalyst. It would mean migrating a shipping iOS app off SwiftPM back onto
CocoaPods, and the podspec declares `s.ios.deployment_target` only, so Catalyst
support would have to be added to it as well. Large, invasive, and a decision
rather than a next step.

**So the macOS options are now:** (a) stay on Apple-Silicon passthrough and
accept its gaps, including the microphone; (b) migrate iOS to CocoaPods to
unblock Catalyst; (c) a non-Capacitor desktop shell (Tauri), which the original
plan listed as the Windows/Linux option; (d) descope macOS. Phase 2 and 3 below
are unreachable until one of those is chosen.

**Phase 2 — make the five items real**, in the order the spike says they matter,
each verified on hardware rather than assumed from iOS. The privacy overlay and
TLS pinning are the two with security consequences, so they get the
prove-it-with-both-controls treatment, not a happy-path check.

**Phase 3 — release path.** Either a manual Organizer archive per release, or an
Xcode Cloud macOS workflow. Read `homelab-glance`'s existing `Archive - macOS`
action first: same Apple account, same "this Mac cannot distribute" constraint,
problem already solved once.

## What I would not do

Enable Catalyst and start fixing the five items in one pass. Every one of them is
a "verify on hardware" item, and this project's own record — TLS pinning proved
with both controls, the unlock-gate test watched failing first, the theme work
re-derived after a bad measurement harness — is that assuming these carry from
iOS is how the expensive debugging starts.
