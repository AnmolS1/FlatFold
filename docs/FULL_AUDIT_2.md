# FlatFold — full audit #2 (2026-07-25)

Second full pass, after the native build, D7 account features, prekey replenishment, and passkey unlock. Covers security, accessibility/design, UX, architecture, testing, and process. Read `STATUS.md` first; this audit deliberately does **not** re-litigate anything in its "Deliberate behaviours" list.

Method: read the code, not the docs. Contrast numbers below are computed from `src/index.css` against the actual component usages, not eyeballed. Severity: **[High] [Medium] [Low] [Info]**.

**Headline:** the security engineering continues to be strong, and the newest crypto (passkey PRF) is soundly designed. The real findings this round are in **theming/accessibility** — the five themes were never checked against the components that consume them, and one of them makes the trust-critical verification screen unreadable. Plus one genuine security gap: **changing your password doesn't revoke device unlock enrollments.**

---

## 1. Security

### S1 [Medium] Changing your password does not revoke passkey or biometric unlock
`stageRewrap` / `promoteRewrap` (`src/keystore/identityRecord.ts`) deliberately keep the **same master key** and only swap the wrap — which is the right envelope design and makes the change atomic. But the consequence is that MK is unchanged, so:
- the passkey wrap (`PASSKEY_STORE`, MK under the PRF-derived key) still opens after a password change, and
- the iOS biometric Keychain item still releases the same MK.

`AuthContext.changePassword` (lines 181–193) calls stage → server → finalize and never touches `disablePasskeyUnlock` / `disableBiometric`.

Why it matters: the main reason a person changes their password is that they think it's compromised. If someone enrolled a passkey or Face ID on a device they had access to, the password change feels like it cuts them off, and it doesn't. Contrast with the server side, which does the right thing (epoch bump kills other sessions).

**Fix:** on a successful `changePassword`, drop the local unlock enrollments for that user (`disablePasskeyUnlock(username)`, `disableBiometric(username)`) and prompt re-enrollment. Cheap, matches expectation, no MK rotation needed. Consider the same on recovery for symmetry (recovery already rotates MK, so stale wraps fail closed and are deleted lazily — but proactive deletion is tidier). Test: enroll passkey → change password → assert the passkey record is gone and unlock falls back to the password.

### S2 [Low] `react-router` advisory (2 high by CVSS, likely not exploitable here)
`npm audit` flags GHSA-qwww-vcr4-c8h2 (RSC-mode CSRF bypass) in `react-router` 7.12.0–8.2.0 via `react-router-dom`. FlatFold uses client-side `BrowserRouter` with no RSC mode and no server actions, so the vulnerable path isn't in play. Still: bump it (`npm audit fix`), because a public security-tool-flagged dependency on an open-source security app is a bad look and the upgrade is trivial. Verify the web + native builds after.

### S3 [Low] Prekey replenishment — I agree with the approach; one residual
The ordering in `src/lib/prekeyReplenish.ts` is **correct**: `keystore.addOneTimePreKeys` persists secrets before the public halves are published, so a crash can't publish a key whose secret was lost. The de-dupe (`inFlight`), the 30-minute cooldown, and setting `lastCheckedAt` only after a *successful* read (so an offline attempt doesn't start a silent blackout) are all right.

I also agree with **rejecting the last-resort prekey**, and the reasoning in the file is the correct one: a reusable prekey sits in the same forward-secrecy position as no OTP at all, so it adds a moving part without buying the property it appears to buy. My earlier audit's suggestion was weaker than what shipped.

Residual: a determined attacker can still drain a targeted user's pool faster than a 30-minute client-side refill (bundle lookups are capped at 30/min per requester), forcing no-OTP fallback for that window. Low, and inherent to client-driven replenishment. Worth one line in THREAT_MODEL #14 rather than code.

### S4 [Info] Verified sound — don't re-open these
- **Passkey PRF design** (`src/lib/webauthnPrf.ts` + `PASSKEY_STORE`): what sits at rest is only MK *wrapped* under an HKDF of the PRF output. Without the authenticator the wrap can't open; no server is involved; a forged assertion buys nothing. This is the strong design, not a soft "did they authenticate?" gate, and it correctly mirrors the iOS Model-A choice. The HKDF domain label, `userVerification: 'required'`, the single-ceremony PRF-at-creation path with a bounded fallback, and the `withTimeout` wrapper (the fix for the enrollment hang) are all correct. Stale-wrap handling fails closed and deletes the record so a dead unlock is never offered.
- **Panic wipe covers the new store** — it deletes the whole IndexedDB database, so `PASSKEY_STORE` goes with it.
- **Recovery rotates MK** (`generateMasterKey()` on the rebuild path), so old wraps can't open the recovered identity.
- **Web notifications are content-free** (`src/lib/webNotify.ts`): decoy label as title, no body, no sender. The THREAT_MODEL #22 claim matches the code. ✓ (their open question #4)
- **The tracked APNs private key in `vitest.config.ts` is a throwaway** test fixture, clearly commented, not used anywhere else; prod's real `.p8` is a Wrangler secret. Not a leak — flagging it only so a future reviewer doesn't file it.

---

## 2. Accessibility / theming — the real findings this round

`STATUS.md` predicted this ("the new themes' accent tokens for the verification UI are best-fit values that were never eyeballed on device"). They're worse than best-fit; three of five themes have failures, computed against real component usage. All pairings below are **text**, so the bar is 4.5:1.

| theme | `text-sax` on card | `text-sax` on orbit panel | white on `bg-sax` button | white on orbit panel |
|---|---|---|---|---|
| Paper (default) | **2.09** | 5.65 | **2.24** | 12.69 |
| Ink | 8.00 | 7.86 | **1.95** | 15.32 |
| Vellum | **4.36** | **3.85** | 4.91 | **1.27** |
| Graphite | **3.25** | **3.90** | **3.25** | 12.69 |
| Midnight Crane | 8.85 | 7.61 | **1.95** | 14.83 |

Bold = fails AA.

### A1 [High] Vellum makes the safety-number screen unreadable
`SafetyNumberDialog` renders its panel as `bg-orbit text-white` (line 155). Vellum sets `--color-orbit: #EDE3CE` — a *light* parchment — so white-on-orbit is **1.27:1**. The verification screen is where users confirm they're not being MITM'd; it's the most trust-critical surface in the app, and in this theme it's effectively invisible. Also affects `text-sax` on that panel (3.85).

**Fix:** either give Vellum a dark orbit (keep the panel's "terminal/console" role consistent across themes), or make the panel's foreground a token (`--color-orbit-fg`) that each theme sets to a readable value instead of hardcoding `text-white`. The token approach is better: it stops the next theme from reintroducing this.

### A2 [Medium] `bg-sax` + `text-white` buttons fail in four of five themes
`SettingsDialog.tsx:386` (and the same pattern elsewhere) puts white text on the gold `sax` fill: 2.24 (Paper), 1.95 (Ink), 3.25 (Graphite), 1.95 (Midnight Crane). White on mid-gold is a classic AA failure. Note `SafetyNumberDialog:224` does it correctly (`bg-sax text-orbit`, 5.65–7.86). **Fix:** standardize on a dark-ink foreground for sax fills (an `--on-sax` token), never white.

### A3 [Medium] `text-sax` as body text fails on card in three themes
Used as text in `SettingsDialog`, `ContactList` (the "Verified" state), `TwoFactorSection`, `Toast`, `Transparency`: 2.09 (Paper — the **default** theme), 4.36 (Vellum), 3.25 (Graphite). The verified-contact indicator being the low-contrast case is unfortunate given what it signifies. **Fix:** darken `--color-sax` per light theme for *text* use, or split the token into `--color-sax` (fill/graphic, 3.0 bar) and `--color-sax-text` (4.5 bar). Icon-only uses (`ShieldCheck`) need 3.0 and mostly pass; the text uses are the problem.

### A4 [Low] Add the contrast check to CI
These are computable. A small test that walks the theme token sets and asserts the known text pairings meet 4.5 (and graphic pairings 3.0) would have caught all three findings before shipping, and prevents the next theme from regressing. The D3 doc's numbers were correct for the pairs D3 specified — the gap is that components use pairs D3 didn't enumerate (`text-white` on sax, `text-white` on orbit). Encode the *actual* pairings.

---

## 3. Architecture

### R1 [Medium] `src/pages/Chat.tsx` — 1,751 lines, no component test
Their own #3, and I agree it's where undiscovered bugs most likely live. It carries the WebSocket lifecycle, the session-op queue, inbound decryption dispatch, offline flush, groups, and timers. The D2 spec already calls for extracting `useMailboxSocket` / `useConversationState` without touching the ratchet region; that's still the right move. Even before refactoring, a test around the inbound-frame dispatch and the offline-flush path would buy a lot — those are the parts with real state-machine complexity.

### R2 [Info] Layout is otherwise healthy
Frozen boundaries are respected and the three freeze exceptions were each narrow, documented, and test-backed. `src/lib` has grown to ~34 modules but they're small and single-purpose. 41 test files / 443 passing tests, `tsc -b` and eslint clean. The two-vitest-project split (workerd vs jsdom) is a good structural decision and the schema-drift test is a genuinely unusual, good idea.

---

## 4. UX

### U1 [Low] Decoy label is honored on web but not native
`webNotify` uses `getDecoyLabel()` as the notification title; native push uses a fixed generic (noted in STATUS as a follow-up needing server storage or a Notification Service Extension). So the same user gets their chosen decoy on web and "New activity" on iOS. Both are content-free, so this is a consistency/expectation gap rather than a leak — but a user who deliberately set a decoy label may reasonably assume it applies everywhere. Either ship the NSE or say plainly in the setting's help text that the label applies to web/PWA notifications only.

### U2 [Info] The unlock-gate escape fix is the right call
Session-valid + keystore-locked previously had no exit but a destructive wipe. The fix (forgot-password and switch-account links on the gate, plus `/login` only redirecting when signed in **and** unlocked) resolves a genuine trap, and pinning it with a test that was watched failing first is exactly right.

### U3 [Low] Two-layer model still needs an in-product explanation
STATUS calls this "the single most confusing thing about the app," and it caused a shipped bug. The D2/D7 specs called for onboarding that explains the two locks; worth confirming that actually shipped in the native UI, since the gate saying "Unlock this device" while not being a login screen is still the sharp edge for new users.

---

## 5. Process / docs

### P1 [Medium] Almost all of `docs/` is gitignored, and evidence was deleted
Only `THREAT_MODEL.md` and `TLS_PINNING.md` are tracked; everything else — the whole design set D1–D7, the build prompts, the audits, this file — exists on one machine with no version control and no backup. The 2026-07-25 cleanup already deleted verification screenshots permanently. For a project whose security claims rest on "it was actually checked," the evidence trail is the asset. **Fix:** either track the design docs (they contain nothing sensitive — the sensitive material is in `.env`/`.dev.vars`, already ignored), or back the directory up somewhere versioned. At minimum keep verification evidence.

### P2 [Low] macOS and Android remain unbuilt
In scope from the start, never begun. Not a defect, but it means the "native apps" story is iOS-only today, and the Play copy / maskable icon / Data Safety work is sitting idle. Worth an explicit decision: schedule them, or descope publicly so the docs stop implying they're coming.

### P3 [Low] Store submission items are drafted but unshipped
D5 copy, D6 privacy label, and the review demo account are ready but not submitted; the demo account needs creating on the live backend. Small, but it's the last gate before the app is actually available.

---

## Priority order

1. **A1** — Vellum's unreadable verification panel (trust-critical, one theme, quick fix).
2. **S1** — revoke passkey/biometric enrollments on password change.
3. **A2 / A3** — sax foreground and text contrast; add **A4** (the CI contrast test) so it can't regress.
4. **R1** — a test around `Chat.tsx`'s inbound/offline paths, then the extraction.
5. **S2** — bump react-router.
6. **P1** — get the docs and verification evidence under version control.
7. **U1 / U3**, then **P2 / P3** (macOS/Android decision, store submission).

Nothing here is a live-exploitable emergency. The encryption core, the zero-knowledge posture, and the newest passkey work all hold up. The pattern worth noting is that this round's real defects were in the **theme layer** — the part that got the least verification discipline, precisely because it looks cosmetic. A1 shows it isn't: a theme can silently disable a security control.
