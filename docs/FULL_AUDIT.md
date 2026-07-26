# FlatFold — full multidisciplinary audit (2026-07)

A whole-team pass: security, publishing readiness, accessibility, performance, UX, code quality, testing, privacy/legal, and build/release. Security is covered heavily but it's no longer the weakest area — the earlier security audit's findings are largely fixed (see §2). The highest-value work now is **publishing readiness**, since the repo is public.

> **Update 2026-07-19.** Publishing blockers (§1) are resolved: public README, AGPL-3.0 LICENSE, SECURITY.md, and `docs/THREAT_MODEL.md` restored to the repo. The two UX bugs (§5) are fixed and verified (message ordering `86997ad`, composer refocus `143e839`); both carry passing tests, which also starts closing the component-test gap (§7). Remaining open items are marked inline.

Severity: **[Critical] [High] [Medium] [Low]**. Items marked **[verify]** are likely fine but need a live check.

---

## 1. Publishing readiness / repo hygiene — the weakest area right now

This is what your README instinct was pointing at, and it's broader than the README.

- **[High] `docs/THREAT_MODEL.md` is missing from the public repo.** The fresh `git init` re-applied `.gitignore` from scratch, and `/docs/*.md` is a blanket ignore with **no negation** for the file the comment says is public. Previously it was tracked only because it predated the ignore rule; the re-init dropped it. So the threat model — good, trust-building content for an E2EE app — isn't published, and the README links to it (broken link). Fix: add `!/docs/THREAT_MODEL.md` to `.gitignore`, `git add -f docs/THREAT_MODEL.md`, commit. Verify `git ls-files docs/` shows it.
- **[High] The README is a development build-log, not a public README.** It's an M1–M7 milestone narrative ("being rebuilt from a Firebase group chat"), it's **stale** (it lists "no sealed sender" as a residual, but sealed sender shipped afterward), and it **links to non-public files** (`REBUILD_PROMPT.md`, `docs/ARCHITECTURE.md`) that aren't in the repo → broken links on GitHub. A public README should open with what FlatFold is and why, the security properties in plain terms, a screenshot or two, quickstart, deploy, and links to the threat model + `/transparency` + license + security policy. Recommend a full rewrite (I can do it in your voice).
- **[High] No LICENSE, and `package.json` has no `license` field.** With no license, default copyright law applies: nobody may legally fork, audit-and-redistribute, or contribute. For a privacy tool whose whole pitch is "you don't have to trust me, you can check it," a license is part of the offer. Pick one deliberately: **AGPL-3.0** (forces any hosted fork to publish its source — strong fit for a privacy project), MIT/Apache-2.0 (max adoption). Add `LICENSE` + the `license` field.
- **[Medium] No `SECURITY.md` / vulnerability disclosure path.** A security product needs to tell researchers how to report privately. You already have `security@flatfold.ponderance.dev` (the VAPID subject). Add `SECURITY.md` and, ideally, `/.well-known/security.txt`.
- **[Low] No CI, no `CONTRIBUTING.md`, no `.github/`.** A public repo inviting scrutiny benefits from a visible green test run (see §7/§9) and a one-page contributor guide.
- **[Low] Thin `package.json` metadata** — no `description`, `author`, `repository`, `homepage`, `keywords`, or `engines` (Node version). Add these for a public project.

## 2. Security — strong, most prior findings fixed

Confirmed **closed** since the last audit (each with a test): SW app-shell integrity pin (`src/sw/shellIntegrity.ts` + `scripts/gen-sw-manifest.mjs`), per-mailbox queue + envelope-size caps (`MAX_QUEUED_ENVELOPES`/`MAX_ENVELOPE_BYTES`), total skipped-key cap with oldest-eviction in both ratchets, `token_epoch` revocation + long sliding sessions, per-user media-upload rate limit, password max length. Plus the standing strengths: parameterized SQL, constant-time compares, audited `@noble`/`@hpke` primitives, verified signed-prekey signatures, sign-before-decrypt group messages, password-reauth account deletion, content-free push, minute-coarsened timestamps, no IP logging.

Remaining / to verify:

- **[verify] CSP on production document responses.** `_headers` doesn't apply to Worker-generated responses; the whole web-client model depends on the HTML shell carrying the CSP. Confirm with `curl -I https://flatfold.ponderance.dev/` and `/chat` that `Content-Security-Policy` is actually present. The README asserts it; verify it.
- **[RESOLVED 2026-07-25] One-time-prekey exhaustion.** ~~The authenticated bundle fetch still consumes an OTP per call, and I don't see a signed **last-resort prekey**. An attacker can still drain a victim's pool to force weaker no-OTP X3DH. Add a last-resort prekey (Signal's approach) so exhaustion degrades gracefully.~~

  Two notes on the finding, then the fix:

  1. **The gap was permanence, not rate.** Each account generated **20** one-time prekeys **once**, at identity creation (`src/keystore/index.ts`), the server deletes each on use, and *nothing ever replenished them* (`apiPublishKeys` ran only at signup and recovery). So once the pool drained it stayed drained forever. The **"Low" severity was right**, though: `lookupBundle` (`src/lib/messaging.ts`) tries the anonymous sealed lookup **first**, and that path returns `oneTimePreKey: null` by construction, so ordinary first contacts consume nothing. Only the authenticated fallback claims an OTP. Draining is therefore slow and the everyday path was never affected. (An earlier draft of this entry claimed twenty ordinary contacts would exhaust an account; that was wrong, and THREAT_MODEL #14 had the ordering right all along.)
  2. **The recommended fix would not have worked**, which THREAT_MODEL #14 had already concluded independently. A last-resort prekey is *reusable* and shared across every initiator, and it is never deleted, so it discards the one-time-ness that is the whole point and leaves first-message forward secrecy where no-OTP X3DH already sits. (Signal's current "last resort" terminology attaches to Kyber prekeys under PQXDH, a different problem.) It was deliberately **not** implemented.

  **Implemented instead: replenishment.** `GET /api/keys/prekeys` reports the remaining count and `POST /api/keys/prekeys` tops the pool up, deliberately separate from `/api/keys/publish` so a refill never rewrites the identity or signed prekey (which would read as a key change to every contact). The client refills to 20 whenever the pool falls to 8 or below (`src/lib/prekeyReplenish.ts`, called once per chat mount). The server caps a stored pool at 100 so refills cannot grow the table without bound.

  **The safety property, and why the ordering is what it is:** `keystore.addOneTimePreKeys` persists the new secrets to the encrypted local doc *before* returning, and only then are the public halves published. Publishing first would risk putting keys on the server whose secrets were never stored, which would wedge first contact for whoever claimed one, unrecoverably, since the server deletes each prekey on use. Same discipline as D7's `stageRewrap`. Pinned by tests that were verified failing against an inverted-order implementation (`test-ui/prekeyReplenishOrchestration.test.ts`), plus a local round-trip property test (`test-ui/prekeyReplenish.test.ts`) and server-side coverage (`test/prekey-replenish.test.ts`). Touching the frozen `worker/**` and `src/keystore/**` was an explicitly sanctioned exception, on the same terms as D7.

  Pre-existing mitigations that remain: one OTP per requester per target per hour, 30 bundle lookups per minute per requester, and the anonymous sealed-sender fetch consumes no OTP at all.
- **[Low] Accepted residuals to keep documented:** login-lockout griefing (no-IP design), username-enumeration via signup 409 / bundle 404 (contact-by-username is intentional), media `DELETE` authorization (unguessable id, in-conversation only), orphaned R2 objects on account deletion (TTL is the backstop). These are fine as documented residuals; make sure they're in the threat model.
- **[Low] Sealed-sender residual** (presence intersection over the receive socket) — already documented honestly; keep the README/marketing claims matched to it (don't let "Signal-grade" outrun the threat model).

## 3. Accessibility

Reasonable baseline: 20/23 component files use `aria-*`/`role`, `MediaAttachment` has `alt`, brand SVGs carry `role="img"` + labels.

- **[Medium] Verify focus management in dialogs and bottom sheets.** `SettingsDialog`, `ConfirmationDialog`, `BottomSheet`, `SafetyNumberDialog`, `MessageActionSheet` should trap focus while open, restore focus to the trigger on close, close on `Esc`, and set `aria-modal="true"` + a labelled title. This is the most common a11y gap in chat UIs. Run the `design:accessibility-review` skill / an axe pass.
- **[Medium] Announce incoming messages to screen readers.** The message list should have an `aria-live="polite"` region (or per-message) so a screen-reader user hears new messages. Chat apps routinely miss this.
- **[Low] Color contrast** — the ponderance theme is AA by design, but spot-check crane-on-graph, sax "near limit" text, and `graphite-40` placeholder/hint text in **both** themes with a contrast checker; 40%-alpha ink often fails AA.

## 4. Performance

- **[Medium] `MessageList` has no virtualization.** Every message renders a DOM node; a long history (thousands of messages) will jank and balloon memory on low-end phones. Add windowing (`virtua`/`react-window`) or render a capped recent window with load-older. Related: local search loads all messages into an in-memory MiniSearch index — fine at personal scale, worth noting for heavy users.
- **[Low] Main bundle ~526 KB uncompressed** (~150 KB gzip estimate) — acceptable for a crypto + React app, but you could lazy-load the camera/QR scanner (safety-number scan) and the `MediaRecorder` voice path, and code-split `@hpke/core` off the initial route.
- **[Low] No `engines` pin / no `npm ci` in a CI.** The reproducible-builds claim (transparency page) wants a pinned Node + deterministic install; pin `engines.node` and use `npm ci` in CI.

## 5. UX / product

- **[Resolved] The two issues you flagged** (message ordering, refocus-after-send) — fixed and verified. Ordering (`86997ad`) carries the sender's precise `sentAt` inside the E2EE payload and sorts by it (server envelope stays minute-coarsened; a test asserts `sentAt` never reaches the wire). Refocus (`143e839`) stops disabling the composer mid-send, adds a ref-based double-submit guard, and prevents the Send tap from blurring the field so the mobile keyboard stays up. 9/9 ordering + 8/8 composer tests pass.
- **[Medium] No React error boundary (see §6).** A render error in one message shouldn't white-screen the whole app.
- **[Low] Connection status.** Confirm there's a visible "reconnecting…" state for the WebSocket so a user knows when messages aren't live. (An `OfflineIndicator` existed in the predecessor; verify it's wired to the WS state, not just `navigator.onLine`.)
- **[Low] First-run/empty state.** With no contacts, guide the user: "add someone by their exact username, and share yours." A cold empty chat list is confusing for a username-only app with no discovery.
- **Good:** mobile safe-area + keyboard handling via `useVisualViewport`, disappearing-message timers, panic wipe, decoy notification label — all thoughtful.

## 6. Code quality / architecture

Genuinely high: **0** TODO/FIXME/HACK markers, no stray `console.log` in shipped source, TS strict, 26 test files, clean module boundaries (`crypto/` is a pure library), no hand-rolled crypto.

- **[Low] Add a top-level React `ErrorBoundary`** around the chat surface with a recover/reload affordance.
- **[Low] `Chat.tsx` is ~1,100 lines** — a god-component holding WS wiring, message state, send/receive, groups, timers. Extract hooks (`useMailboxSocket`, `useConversationState`) for maintainability. Not urgent, but it's where bugs will hide.
- **[Low] `worker-configuration.d.ts` (549 KB, gitignored, regenerated on `postinstall`)** — a fresh clone with no network for `wrangler types` fails typecheck. The README documents it; consider committing a checked-in copy or a fallback so CI/first-clone is robust.

## 7. Testing

Strong crypto + worker coverage (91 tests). Gaps:

- **[Partly resolved] React component/UI tests.** A `test-ui/` suite now exists (jsdom + Testing Library): `MessageInput.test.tsx` covers the composer and `test/message-ordering.test.ts` covers the conversation sort — the exact gap that let the two bugs through is now closed, and the harness lowers the bar for more. Still thin overall: no tests yet for `MessageList`, dialogs/bottom sheets, or the contact/group flows. Extend coverage as those areas change.
- **[Medium] Playwright E2E exists but isn't in CI**, so it doesn't guard regressions automatically.
- **[Low] No coverage reporting** — wire `vitest --coverage` so gaps are visible.

## 8. Privacy / legal / content

- **[Medium] No privacy policy / terms for a live service** that holds accounts (username + password) and sends push. The `/transparency` page is honest about *data stored* but isn't a privacy policy or ToS. You already have a registry-driven `/privacy` + `/terms` system on ponderance — wire FlatFold's product into it.
- **[Low] Marketing/claim discipline.** "Signal-grade" is a strong public claim. Keep it tethered to the threat model's stated residuals so a security reader doesn't find daylight between the pitch and the doc.

## 9. Build / release / ops

- **[Medium] No CI/CD.** Add a GitHub Action: `npm ci && npm run lint && npm test && npm run build` on every PR (and optionally deploy on merge to `prod`). For a live app this is the cheapest regression insurance and a public trust signal.
- **[Low] No Dependabot/Renovate** on a security product — automate dependency and advisory updates.
- **[Low] Reproducible-build procedure** (referenced by `/transparency`) should be a documented, runnable recipe (pinned Node, `npm ci`, deterministic `vite build`, expected asset hashes) so a third party can actually reproduce and check the shell.

---

## Priority order (highest value first)

1. ~~**Publishing blockers:** restore `docs/THREAT_MODEL.md`; public README; `LICENSE`; `SECURITY.md`.~~ **Done (2026-07-19).** (§1)
2. ~~**Ship the two UX fixes** (ordering + refocus).~~ **Done (2026-07-19), tests passing.** (§5)
3. **Verify the CSP is live** on prod document responses. (§2)
4. **Accessibility:** focus-trap the dialogs, add a live region for incoming messages. (§3)
5. **CI** running lint + tests + build on PRs (the `test-ui/` + worker suites now exist to run there). (§7, §9)
6. **Then:** message-list virtualization, error boundary, last-resort prekey, privacy/terms wiring. (§4, §6, §2, §8)

Nothing here is a live-security emergency — the encryption core and the server's zero-knowledge posture are solid and now well-tested. The gap is the difference between "a strong app that works" and "a public open-source security project people can trust, contribute to, and verify."
