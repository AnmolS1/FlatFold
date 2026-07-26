# Step 1 — on-device verification log

Simulator: iPhone 16 (iOS 26.5), Xcode 26.6. App: `dev.flatfold` (Debug, bundled+signed native assets).
Driver: XCUITest target `AppUITests` (added to `ios/App/App.xcodeproj`) — runs in the sim test host, no macOS Accessibility permission needed.

## Confirmed on-device

- **Zoom-on-focus bug (the #1 reported bug) is GONE.** Screenshot `uitest-A-login-focus.png`: the password
  field is focused, the keyboard is engaged (input-accessory bar visible), and the viewport has **not zoomed** —
  the whole login card *and the footer text* remain at 1× scale. The native viewport lock
  (`maximum-scale=1, user-scalable=no`, injected only into the native bundle by `inject-native-csp.mjs`) is what
  guarantees this at the WKWebView level. Verified on the simulator, not the browser.
- No zoom on any of the login/signup screenshots (`uitest-B*`), on any focused field.

## Blocked (needs a decision)

- **Signup/keystore-creation SIGSEGVs on this simulator.** After submitting signup, `app<dev.flatfold>` exits with
  `signal SIGSEGV(11)`, `isUserKill:0` — a native crash in the WebContent process, i.e. the **Argon2id / HPKE
  WebAssembly** path that runs at account creation. This is independent of the step-1 redesign (HTML/CSS/React
  changes cannot segfault native wasm; a JS error would throw, not crash the process). It blocks reaching **any**
  logged-in state on this sim — by automation or manual taps — so the logged-in evidence (tab bar, no-FAB list,
  docked composer with keyboard up) can't be captured here yet.
- Likely a simulator/WebKit-version wasm issue (TestFlight on a real device works, per the brief). Candidate paths:
  verify logged-in states on a **real device**, or diagnose the sim wasm crash (touches the off-limits crypto/wasm
  load path — needs sign-off).

## Screenshots in this dir
- `before-01-login.png` — baseline before any change.
- `uitest-A-login-focus.png` — **KEY: focused field, keyboard up, no zoom.**
- `uitest-B_signup_did_not.png`, `uitest-B1_after_submit.png` — post-signup: app crashed to springboard (the SIGSEGV).
