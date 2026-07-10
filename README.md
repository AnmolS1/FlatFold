# FlatFold

A private, web-first messenger being rebuilt from a Firebase group chat into
a Signal-grade end-to-end encrypted messenger on Cloudflare. See
[`REBUILD_PROMPT.md`](./REBUILD_PROMPT.md) for the full product spec and
7-milestone roadmap, and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
for what's actually built so far and the tradeoffs made along the way.

## Status: Milestones 1–7 complete — deployed to https://flatfold.ponderance.dev

The rebuild is done and **live in production** on Cloudflare. See
[Deployment](#deployment) below for the runbook and the resources it created.

**Milestone 1 (Scaffold)** stands up the Cloudflare architecture and the
ponderance.dev visual language: a Worker + D1, a "mailbox" Durable Object
per user (WebSocket + Hibernation API), username + password auth (Argon2id,
short-lived signed session cookie), and the ponderance-themed app shell. No
live Cloudflare deploy yet — everything runs locally via
`@cloudflare/vite-plugin`, no Cloudflare account required.

**Milestone 2 (Crypto core)** adds `src/crypto/` — X3DH + Double Ratchet as
a standalone, well-tested TypeScript library (`@noble/curves`,
`@noble/ciphers`, `@noble/hashes`; no hand-rolled crypto). See
`docs/ARCHITECTURE.md` for the design tradeoffs (two separate identity
keypairs instead of Signal's XEdDSA, no header encryption yet, and a
transactional-decryption bug an advisor review caught and a regression test
now guards against).

**Milestone 3 (real 1:1 messaging)** wires M2's crypto into the app for
real: an encrypted local keystore (`src/keystore/`, password-derived via
Argon2id, IndexedDB), identity/prekey publish + fetch (`worker/keys.ts`,
atomic one-time-prekey consumption, rate-limited), a mailbox DO that routes
between users with **at-least-once delivery + idempotent receive**
(ack-gated queue deletion, send-order-preserving offline queue, a 14-day
TTL sweep, and live "delivered" receipts), and a full chat UI:
add-contact, per-conversation history, sent/delivered checkmarks, and
**safety-number verification** (60-digit fingerprint committing to both
identity keys, digit blocks + QR + camera scan) with **identity-key-change
detection** that raises a non-dismissable warning and clears prior
verification. Verified end-to-end across two isolated Playwright browser
contexts — encrypted send/receive both ways, the ack-gated offline queue,
delivered receipts, the keystore-unlock gate (a separate step from server
login), and key-change detection on a peer's identity reset. See
`docs/ARCHITECTURE.md` for the delivery-model design (the ack change flips
delivery to at-least-once, which is only safe because receive is
idempotent) and the two-keypair safety-number construction.

## Getting started

```sh
npm install
npm run dev
```

`npm install` also generates `worker-configuration.d.ts` (a `postinstall`
hook runs `wrangler types`) — it's gitignored since it's derived from
`wrangler.jsonc`, so it has to exist before `tsc`/`vite build` will
typecheck the Worker on a fresh clone. Re-run `npm run cf-typegen`
manually any time you edit `wrangler.jsonc`.

This starts one process that serves the React client (with HMR) **and**
runs the Worker + Durable Object + D1 locally via `workerd` — no
`wrangler dev`, no Cloudflare account, no remote resources.

The local D1 database needs its schema applied once (and again any time you
wipe `.wrangler/state`):

```sh
npx wrangler d1 migrations apply DB --local
```

Then open http://localhost:5173, sign up with a username and password, add
a contact by their exact username, and send a message — it's end-to-end
encrypted client-side (X3DH + Double Ratchet), routed through the Worker
and mailbox Durable Objects as opaque ciphertext, and decrypted on the
recipient's device.

## Other scripts

```sh
npm test          # vitest run — auth, keys, mailbox DO, and crypto tests, real Cloudflare runtime
npm run lint       # eslint
npm run build      # tsc -b && vite build
npm run cf-typegen # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

## Deployment

FlatFold is deployed as a single Worker (`flatfold`) with static assets,
custom-domain-only at **`flatfold.ponderance.dev`** (no `*.workers.dev` URL).
The `@cloudflare/vite-plugin` build generates the deploy config, so deploying
is just:

```sh
npm run build && npx wrangler deploy
```

Cloudflare resources it uses (created once):

- **D1** `flatfold` (`database_id` in `wrangler.jsonc`) — schema applied with
  `npx wrangler d1 migrations apply flatfold --remote`.
- **R2** `flatfold-media` — encrypted attachment ciphertext.
- **Durable Object** `Mailbox` (one per user) — created by the deploy's DO
  migration.

**Secrets** are never committed. `SESSION_SECRET` and `VAPID_PRIVATE_JWK` are
set in production via `npx wrangler secret put <NAME>` and locally via a
gitignored `.dev.vars` (the non-secret `VAPID_PUBLIC_KEY` / `VAPID_SUBJECT`
stay in `wrangler.jsonc` `vars`). The CSP and other security headers in
`public/_headers` are enforced by Workers static assets in production (verify
with `curl -I https://flatfold.ponderance.dev`) — but **not** under `vite
dev`, so CSP/service-worker changes must be validated against `vite preview`
or the deployed site.

> Note: because a D1 `database_id` keys miniflare's *local* store too, after
> changing it re-seed local dev with
> `npx wrangler d1 migrations apply flatfold --local`.

## Security invariants

The rebuild spec sets seven non-negotiable invariants (plaintext never
leaves the device, the server stores no delivered messages, private keys
never leave the device, forward secrecy, metadata minimization, hard account
deletion, no third-party trackers/CDNs). As of M3 most are enforced
end-to-end, not just as library properties:

- **Plaintext never leaves the device / private keys never leave the
  device** — encryption is client-only; keys live encrypted-at-rest in
  IndexedDB (Argon2id-derived key).
- **Server stores no delivered messages** — live-delivered messages are
  never persisted; a queued (offline-recipient) envelope is deleted on the
  recipient's ack and hard-TTL'd at 14 days regardless.
- **Forward secrecy / post-compromise security** — the Double Ratchet, now
  actually driving the app.
- **Metadata minimization** — stored envelope timestamps coarsened to the
  minute; contact lists live only in the encrypted local store; no read
  receipts persisted server-side.
- **No third-party trackers / CDNs** — self-hosted fonts, no CDN scripts,
  no runtime dependencies fetched cross-origin.

Still partial (documented in `docs/ARCHITECTURE.md`): hard account deletion
(the keystore wipe / panic wipe exist; server-side row/queue deletion is a
later milestone), and the web-client trust caveat (the server ships the JS)
— addressed by the M6 transparency page and M7 hardening (CSP/SRI/service-
worker pinning). That doc keeps a running account of which invariant is
enforced by which code.

**Milestone 4 (Features)** adds disappearing messages (per-conversation
timer negotiated in-channel, symmetric expiry), panic wipe (two-step
control + triple-Esc chord; works while locked and offline), encrypted media
+ voice notes (client-side ChaCha20-Poly1305, R2 ciphertext, in-message key,
digest-verified, fetch-ack deletion), and local-only full-text search
(in-memory MiniSearch, never persisted, never networked). All built on a new
typed-payload envelope inside the encrypted channel.

**Milestone 5 (Groups)** adds group messaging via sender keys
(`src/crypto/senderKey.ts`): an HMAC hash-ratchet per sender, **every message
signed per-sender with an Ed25519 key** so no member can forge as another
(verified before decrypt, tested adversarially). Sender keys are distributed
pairwise over the Double Ratchet; group content messages are
sender-key-encrypted and fanned out to each member's mailbox. Membership
add/remove is creator-authoritative with **rekey on removal** — every
remaining member rotates their sender key so a removed member's retained keys
go dead (the security-critical property, gated by a crypto-level test, not
just a UI test). Verified end-to-end across real 3-member groups: all
directions, forward secrecy on add, and removal secrecy. **Deferred**
(documented): full-mesh distribution + X3DH glare tie-breaking (creator-relay
is the v1 stand-in), group attachments, and group disappearing timers.

**Milestone 6 (PWA, push, transparency, polish)** adds an installable PWA
with an app-shell-only service worker (offline read of local history);
**content-free Web Push** — a payload-less "wake up and sync" signal that
carries no message text or sender (VAPID via WebCrypto, not the Node
`web-push` lib); a public **/transparency page** enumerating every field the
server stores, guarded by a build-failing schema-drift check; the origami
**paper-fold send animation** (respects `prefers-reduced-motion`); and a
settings panel with a **session manager** (honest "sign out," not "revoke")
and a **decoy notification label** for shoulder-surfing. A CSP `wasm-unsafe-eval`
fix here restored the production build (client-side Argon2id was silently
CSP-blocked — caught only by testing against `vite preview`, not `vite dev`).

**Milestone 7 (Hardening)** closes out the rebuild: **account deletion**
(invariant #6 — password-reauthed, synchronously wipes the D1 rows + the
mailbox DO's queued ciphertext), **auth rate limiting** (per-username login
brute-force throttle), a tightened CSP (`style-src` dropped `'unsafe-inline'`
entirely, verified in `vite preview`), a dependency audit (react-router
advisories patched; `npm audit` clean), and the security capstone —
[`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md), a threat model plus a
per-invariant self-review that points each of the seven invariants at the
code enforcing it and states residuals plainly. The two residuals a
security-conscious user should weigh are called out there and on
`/transparency`: **the communication graph + timing are visible to the
server** (no sealed sender), and **the web-client bootstrap** (the server
ships the JS). 91 tests pass.
