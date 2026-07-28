# FlatFold — submission audit, end to end (2026-07-28)

Answers `redesign/HANDOFF_SUBMISSION_AUDIT.md`, plus the cross-site accuracy and screenshot questions. Everything below was read from the live sites and the repo today, not from the design docs.

**Verdict: two hard blockers (screenshots, Mac build), one cheap fix that prevents a likely rejection (review notes), and a set of cross-site inaccuracies that all stem from one root cause — the public-facing story still says "FlatFold is a web app," and it hasn't been for a while.**

Severity: **[Blocker] [High] [Medium] [Low] [Verified]**

---

## 1. The screenshot question — solved, with one thing to check

You need exact pixel dimensions. Apple checks dimensions, not device provenance. Every size you listed maps cleanly onto a **real device's logical resolution × its DPR**, which means a browser rendering at that viewport produces a pixel-exact, honest screenshot:

| target | viewport | DPR | is the real logical size of |
| --- | --- | --- | --- |
| 1242×2688 | 414×896 | 3 | iPhone 11 Pro Max / XS Max (6.5") |
| 1284×2778 | 428×926 | 3 | iPhone 12/13/14 Pro Max (6.7") |
| 2048×2732 | 1024×1366 | 2 | iPad Pro 12.9" |
| 2064×2752 | 1032×1376 | 2 | iPad Pro 13" (M4) |
| 2880×1800 | 1440×900 | 2 | Mac (Retina) |
| 2560×1600 | 1280×800 | 2 | Mac (Retina) |

**Why this matters here specifically:** `STATUS.md` records that the **iOS simulator cannot reach a logged-in state** (Argon2/HPKE WASM segfaults there), so you cannot screenshot the actual chat UI from a simulator. That is the thing that would otherwise block this. The web app has no such problem, so:

- **iPhone + iPad:** drive `flatfold.ponderance.dev` (or a local build) with **Playwright** at `viewport` × `deviceScaleFactor` from the table. Deterministic, scriptable, pixel-exact, repeatable for every future release. Playwright is already in this project.
- **Mac:** capture the **real Catalyst app** — it runs and logs in today. Size the window to **1440×900 points** on a Retina display and `screencapture` gives exactly 2880×1800.

**[High] The one thing to verify before shooting:** the native UI is gated on `isNativePlatform()` in places (tab bar, docked composer, native-only affordances), so a browser rendering may not match what the native app shows. Screenshots must depict the app as it actually appears on that platform — that's both an Apple expectation and an honesty one. Check a web render side by side with a device screenshot; if they differ materially, force the native layout for the capture (a debug flag that makes `isNativePlatform()` return true) rather than shipping shots of a different UI.

**[Medium → High] Mac screenshots have a design prerequisite, and it is worse than "doesn't use the width."** `NATIVE_MACOS_PLAN.md` records a layout dead-end above 900px that Catalyst inherits from iPad. Measured incidentally on 2026-07-28 while debugging the link probe: **a default-sized Catalyst window renders the PHONE chrome** — `showHeaderSettings`/`showTabBar` in `chatChrome.ts` put Settings in the bottom tab bar rather than the header, which is the narrow-window branch. So a 1440×900 capture would show a Mac app wearing a phone's tab bar, not merely a roomy layout. Fix the wide layout before shooting; this changes what item 5 costs.

---

## 2. Cross-site accuracy — one root cause

**Everything public still describes FlatFold as browser-only.** That was true when I wrote it; it isn't now.

### [High] `ponderance.dev/support` lists FlatFold as web-only
`src/data/support.ts` has `platforms: ['web']`, so the page files FlatFold under **"On the web"** with a single "Web" badge, and its requirements say only "Any modern browser." The comment at the top of that file already knows better (*"flatfold — 1.0 Prepare for Submission (iOS + macOS) → NOT linked yet"*), so the prose drifted from the data. Fix on approval: `platforms: ['ios', 'ipad', 'mac', 'web']`, move it to the Apps group, add device requirements, and set the App Store link (the `APP_STORE_ID` entry already exists — `appStoreUrl('flatfold')` is ready to switch on, exactly like the Calque pattern).

### [High] The Workshop entry is stale — and I wrote it
`src/content/work/flatfold.md` says the app "runs entirely in a browser" and calls it "a messenger that lives in a browser," and its `stack` omits Capacitor/Swift/iOS. The final paragraph — the honest one about the web-client caveat — now needs nuance, because a signed native client is precisely what closes that caveat. That paragraph is the best thing in the entry, so it should be updated rather than deleted: the caveat still applies to the web client, and the native app is the answer to it. Add `Capacitor`, `Swift` to the stack.

### [Medium] `ponderance.dev/privacy` may not list everything the server now stores
`legal-services.ts` `collects` covers account, published keys, queued ciphertext, and attachments — but I don't see the fields added since: **recovery verifier/blob/salts, TOTP secret, backup-code hashes, APNs device tokens.** The in-app `/transparency` page has all of them (§3 below); the privacy policy is the document Apple links, so it should not say less than the app does. Reconcile the two.

### [Medium] Support is footer-only on ponderance.dev
The main nav is Ponderance / Whoami / Workshop / Commissions / Marginalia; Support appears only in the footer strip. For a site that now backs five App Store products, and given Apple expects a reachable support URL, Support deserves a primary-nav slot or at least a prominent link from each product surface. Your instinct here was right.

### [Blocker-adjacent, High] FlatFold's own app has no Support link, and Privacy/Terms are unreachable once signed in
`src/pages/Login.tsx` is the **only** place linking `ponderance.dev/privacy/` and `/terms/` — so a signed-in user (i.e. every user after day one) has no path to either, and **there is no Support link anywhere in the app at all**. `AboutSection.tsx` already exists in Settings with version, "View source," `/transparency`, and the security email — that is exactly the right home. Add Support, Privacy, and Terms there. Cheap, and it closes an Apple 1.5 expectation as well as a real usability gap.

---

## 3. [Verified] The transparency claim holds

The store description promises "a plain-language page in the app that lists every single thing the server stores." I checked `src/data/serverState.ts` against all nine migrations, column by column: **every column is declared**, including `token_epoch`, all four `recovery_*` fields, all three TOTP fields, and the `apns_subscriptions` table. The schema-drift test is doing its job. The claim is true and the page is genuinely complete — this is the strongest thing in the submission and it should stay that way.

---

## 4. App Store Connect — confirming the handoff's blockers

I have no way to read ASC from here, so §1 of the handoff stands as measured. Ordered by what I'd do first:

1. **[Blocker] Review notes are empty on both platforms.** This is the cheapest fix with the highest rejection-avoidance value: `D5b_app_review_notes.md` already explains the thing a reviewer cannot deduce — FlatFold needs **two** accounts because there's no server-side history, so one account looks like a broken, empty app. ASC's demo-account field holds one. Paste the notes. Do this before anything else; it's minutes.
2. **[Blocker] Screenshots, both platforms.** Solved above.
3. **[Blocker, macOS only] No Mac build has ever been uploaded.** Signing → archive → upload is untouched work, and it's gated behind the layout question in §1 anyway. **Consider shipping iOS first and Mac when it's ready** — there's no requirement to submit both together, and the Catalyst gaps (native file save missing, flat waveforms, the voice-note playback work in flight) are real. A strong iOS launch beats a simultaneous one with a weak Mac build.
4. **[High] Privacy label vs `PrivacyInfo.xcprivacy` disagreement.** The manifest declares only `NSPrivacyCollectedDataTypeUserID`; `D6` says the push token should also be disclosed and flags it `[sign-off]`. Given `apns_subscriptions` genuinely stores a device token tied to a username, **I'd disclose it** — it's linked, it's for App Functionality, not tracking, and under-disclosing is the failure mode that gets an E2EE app challenged. Update the manifest and the label together so they agree.
5. **[High] The load-bearing privacy answer needs your explicit sign-off:** declaring end-to-end-encrypted message content as **not collected**. It's honest, it's what other E2EE messengers do, and it's defensible because the server cannot read it — but it's an affirmative claim, so make it knowingly rather than inheriting it from my draft.
6. **[Medium] Accessibility declarations are empty (`total: 0`).** There has been a real accessibility pass (focus traps, live regions, Dynamic Type, the contrast work), so there are truthful answers to give. Confirm whether they're required for a new submission this cycle, then fill them from the actual pass rather than optimistically.
7. **[Low] EULA is unset, so Apple's standard EULA applies, while the app is AGPL-3.0.** Not a conflict for a free app (the AGPL governs the source; Apple's EULA governs the binary distribution), but it deserves a deliberate decision rather than a default, precisely because you'd want the answer ready if asked.
8. **[Verified — do not "fix"] `ITSAppUsesNonExemptEncryption = false`** is correct and reasoned in `ENCRYPTION_COMPLIANCE.md`: public source releases it from the EAR under the Nov 2024 BIS rule.

---

## 5. Suggested order

1. Paste the review notes (minutes, prevents a likely rejection).
2. Add Support / Privacy / Terms to `AboutSection` in the app.
3. Resolve the push-token disclosure; make manifest and label agree; sign off the E2EE-not-collected answer.
4. Verify web-vs-native rendering, then shoot iPhone + iPad screenshots with Playwright.
5. Fix the >900px Mac layout, then shoot Mac screenshots — or defer macOS entirely and ship iOS first.
6. Update `support.ts` platforms + store link, the Workshop entry, and the privacy `collects` list — these can land the day iOS is approved.
7. Accessibility declarations; EULA decision.

## 6. Constraints respected

No secrets, tokens, demo-account credentials, or personal identifiers are recorded here — the ASC API returns several of those and none belong in a public repo. Frozen paths untouched; nothing in this audit needs them.

---

# Part 2 — the work split (added 2026-07-28)

Review notes are **done** (entered in ASC). Corrections and assignments below.

## 7. Correction: theme contrast is already fixed — do not re-do it

Audit #2 found AA failures on `text-sax` and `bg-sax`+white. **They are fixed.** The fix was the right one architecturally: fill and text tokens were split, so components now use `--color-sax-ink` for text, `--color-on-sax` on sax fills, and `--color-sax-on-orbit` / `--color-orbit-fg` on the verification panel. Measured across all five themes:

| theme | sax-ink on card | on-sax on sax | sax-on-orbit on orbit |
| --- | --- | --- | --- |
| Paper | 5.70 | 6.56 | 5.65 |
| Ink | 8.00 | 9.04 | 7.86 |
| Vellum | 5.66 | 5.81 | 6.60 |
| Graphite | 6.38 | 5.47 | 5.65 |
| Midnight Crane | 8.85 | 9.65 | 7.61 |

All clear 4.5. Vellum's unreadable safety-number panel (1.27) is gone. `test-ui/themeContrast.test.ts` now encodes the *real* component pairings — including alpha-composited chips and the `black/25` digit block — which is exactly the A4 recommendation, implemented better than it was specified. **Sufficient Contrast can be claimed on the accessibility label.**

(Note for future audits, including mine: measuring `--color-sax` against text is now a false positive. Check what the components actually reference.)

## 8. Claude Code can do these

**Items 1, 2 and 4 are DONE (2026-07-28). Item 3 is STAGED, not done** — see
below. Item 5 (screenshots) and item 6 (the ponderance accuracy pass, which
waits for iOS approval) are not started. Measured
results, and the one place the measurement stops short:

- **Item 2's external-link risk does not exist here**, on either platform.
  Clicking each of the four About links left `location.href` at
  `capacitor://localhost/chat` with the app intact — `view source`, `support`,
  `privacy policy`, `terms`, all four, on **Mac Catalyst and a real iPhone**.
  The mechanism: Capacitor's `WebViewDelegationHandler` cancels any top-level
  navigation to a non-application URL and hands it to
  `UIApplication.shared.open`, and it handles `target="_blank"` the same way in
  `createWebViewWith`. `allowNavigation` would override that; this app
  configures none. **So no `openExternal()` helper is needed** — the audit's
  contingency does not apply.
  Driven by `--verify-links` (DEBUG, `MainViewController`).
- **What that test does NOT prove:** a synthetic `.click()` carries no user
  activation, so the browser never actually opened during the run — no
  github.com tab appeared. The strand question is settled; "a real tap opens the
  system browser" rests on Capacitor's source, and is pre-existing behaviour of
  a link that already shipped. One human tap would close it.
- **Item 3 is HALF done, and the half that is missing is the one that ships.**
  The manifest now declares the push token, but `PrivacyInfo.xcprivacy` is
  **bundled**: it is inert until a build carrying it is uploaded, and the only
  builds on ASC are 1 and 2, both of which predate this change. So the order is
  **manifest → build 3 → ASC label**, and filling in the label today would
  describe a build that does not declare the token. The upload is Anmol's step
  (§9) — this Mac holds only an Apple Development certificate and cannot
  distribute.
- Item 1 landed in the **ponderance** repo on branch `fix/home-footer-support`,
  not on `prod`, and is unpushed.

Two probe bugs worth remembering, because both reported a working app as broken:
Settings has **two homes** (a header glyph with `aria-label="Settings"` when the
window is wide, a bottom tab-bar item labelled by its text when it is not —
`chatChrome.ts`), and a default-sized Catalyst window gets the tab bar; and the
Settings dialog takes longer than a fixed 2.5s beat to mount, so the link has to
be polled for. Each first surfaced as "no View source link found".

### The original list



1. **ponderance: Support in the home footer.** The default footer (`Base.astro:160`) already has Support/Privacy/Terms; the home page overrides the footer slot and its PAGES column omits it. Add one line to `src/pages/index.astro` after line 208, matching the siblings exactly:
   `<a href="/support" style="text-decoration: none; color: inherit;">Support</a>`
   No nav change — that would be overcorrecting.
2. **FlatFold: Support / Privacy / Terms in `AboutSection.tsx`.** Append three rows to the existing `flex flex-col gap-1.5` stack, same pattern as "View source". Support → `https://ponderance.dev/support/flatfold` (the product page, not the index). Keep the Login-page links too; they serve a different moment.
   **The risk here is not layout, it is external-link behaviour.** In a `capacitor://localhost` webview an `<a href="https://…">` can navigate the *webview itself* away from the app, stranding the user with no chrome to get back. **Test the existing "View source" link on iOS and Catalyst first** — it uses the identical pattern, so it answers the question for all four links. If it strands the user, fix all four with one `openExternal()` helper (Capacitor Browser on native, plain anchor on web) and treat it as a pre-existing bug found.
3. **`PrivacyInfo.xcprivacy`: add the push token.** Add `NSPrivacyCollectedDataTypeDeviceID`, linked `true`, tracking `false`, purpose `NSPrivacyCollectedDataTypePurposeAppFunctionality`, alongside the existing `UserID`. **This is bundled, so it needs a new build (3) uploaded before the ASC label is filled in** — manifest first, then label, or the shipped build contradicts the label.
4. **LICENSE: add the AGPL §7 App Store exception** (text in §11 below). Put it in `LICENSE` under the AGPL text or in a `NOTICE` file referenced from it, and mention it in the README's licence section.
5. **Screenshots** via Playwright at the viewport × DPR pairs in §1 — but **verify web-vs-native rendering first** (§1's High item). Mac shots come from the real Catalyst app at 1440×900 points on Retina.
6. **ponderance accuracy pass** (do when iOS is approved, not before): `support.ts` `platforms: ['web']` → include iOS/iPad/Mac and switch on `appStoreUrl('flatfold')`; the Workshop entry's "runs entirely in a browser" language and its `stack` (add Capacitor, Swift); and the `legal-services.ts` `collects` list, which omits the recovery fields, TOTP fields, and APNs tokens that `/transparency` already declares.

## 9. Only Anmol can do these (ASC web UI)

- **App Privacy label** — see §4.4/§4.5 and §10 below.
- **Accessibility labels** — §10.
- **Custom EULA** — §11.
- Screenshot upload, build upload, submission.

## 10. Exact answers to give

**App Privacy (must match the manifest after build 3):**
- **Identifiers → User ID** — collected, **linked**, purpose **App Functionality**, *not* used for tracking. (The username.)
- **Identifiers → Device ID** — collected, **linked**, purpose **App Functionality**, *not* used for tracking. (The APNs / web-push token.)
- **Everything else: not collected.** Specifically message content, photos, audio, and contacts. The justification, worth recording verbatim because it is the answer if challenged: Apple defines collection as transmitting data off-device *"in a way that allows you… to access it."* End-to-end encryption means the developer cannot access it, so it is not collected. The same reasoning covers the encrypted recovery blob and queued ciphertext — stored, but opaque to the server. This is the position Signal and WhatsApp take.

**Accessibility labels — claim four, omit the rest:**
- ✅ **VoiceOver** — labels/roles, `useModalDialog` focus traps, the polite live region for incoming messages.
- ✅ **Larger Text** — Dynamic Type support.
- ✅ **Reduced Motion** — `prefers-reduced-motion` respected, including the paper-fold send animation.
- ✅ **Sufficient Contrast** — now true and CI-enforced (§7).
- ❌ **Captions / Audio Descriptions** — voice notes have no transcripts. Do not claim.
- ❌ **Voice Control** — untested. Do not claim.
- ⚠️ Before ticking VoiceOver, do one real pass with it on the main flows. STATUS notes the toast position and unlock-gate links were never audited. An inaccurate accessibility claim is worse than an omitted one.

## 11. The licence exception and the EULA

**Why this matters:** AGPL-3.0 is GPL-family, and GPL-family licences forbid imposing additional restrictions — which Apple's standard EULA does (device limits, DRM). This is the conflict that got VLC pulled from the App Store in 2011. As **sole copyright holder** you can resolve it by granting an explicit exception, and you should do it **before accepting outside contributions**, because afterwards every contributor must agree too.

*Not legal advice — the conflict is well documented and this is the standard remedy, but it is worth a lawyer's glance.*

### Additional permission — add to `LICENSE`

> **Additional permission under GNU AGPL version 3 section 7**
>
> As a special exception, Anmol Saxena, as the sole copyright holder of FlatFold, grants you additional permission to convey copies of the Program through the Apple App Store and other Apple-operated distribution channels, notwithstanding any terms Apple imposes on end users that would otherwise conflict with sections 4, 5, 6, or 10 of this License — including, without limitation, restrictions on the number of devices on which a copy may be installed, or on an end user's ability to copy, modify, or redistribute it.
>
> This permission applies only to distribution through those channels. It does not otherwise limit your rights or obligations under the GNU Affero General Public License version 3, and it does not waive section 13: the Corresponding Source for any version conveyed through those channels remains publicly available at https://github.com/AnmolS1/FlatFold.
>
> If you modify this Program, you may extend this exception to your version, but you are not obligated to do so.

### Custom EULA — ASC → App Information → License Agreement → Custom

Apple requires a custom agreement to carry their **minimum terms** (Apple as third-party beneficiary, no Apple warranty/support obligation, export-compliance acknowledgement, and so on). So the custom EULA is *the AGPL notice plus Apple's required addenda*, not the AGPL alone. Skeleton:

> FlatFold is free software, licensed to you under the GNU Affero General Public License version 3, together with the App Store additional permission described in the project's LICENSE file. The complete Corresponding Source is available at https://github.com/AnmolS1/FlatFold.
>
> To the extent this agreement conflicts with the AGPL, the AGPL governs your rights in the software itself; the terms below are Apple's required terms for distribution through the App Store.
>
> [Apple's required minimum terms — acknowledgement that the agreement is between you and Anmol Saxena and not Apple; that Apple has no maintenance or support obligation; warranty, product-claims, and intellectual-property provisions; export compliance; and that Apple and its subsidiaries are third-party beneficiaries entitled to enforce this agreement.]

Fill the bracketed block from Apple's current published minimum terms (linked from the License Agreement screen in ASC) rather than from memory — they change, and this is the part that gets an agreement rejected.
