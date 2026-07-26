# Architecture

This tracks what's actually built, as it's built, milestone by milestone.
See [`REBUILD_PROMPT.md`](../REBUILD_PROMPT.md) for the full target spec.
Where this doc and that one disagree, this one describes the current state
of the code; that one describes the destination.

## Milestone 1 — Scaffold

Stack: Cloudflare Workers + Durable Objects + D1, served via
`@cloudflare/vite-plugin` so the whole thing — client HMR and the Worker
runtime — runs in one `npm run dev` process with **no Cloudflare account**
and no live deploy. `wrangler.jsonc` deliberately has no `routes` /
`custom_domain` yet; those get added when a real deploy is wired up in a
later step. The eventual production hostname is `flatfold.ponderance.dev`
(a `custom_domain` route on the already-Cloudflare-hosted `ponderance.dev`
zone) — noted here for that later step, not added to `wrangler.jsonc` yet
since we're still local-dev-only.

### Brand

`src/components/common/Brand.tsx` — `LogoMark`, `LogoWordmark`,
`EmptyStateIllustration`, inlined from the SVGs provided in `brand/`
(rather than `<img>`-referenced) so they read the page's `var(--color-*)`
custom properties and follow the light/dark toggle. `LogoWordmark` on the
login page, `LogoMark` in the chat header and loading states,
`EmptyStateIllustration` for the no-messages-yet state. `brand/favicon.svg`
and the PWA icons (`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`,
`apple-touch-icon.png`) are copied into `public/` and wired into
`index.html` + a new `public/manifest.webmanifest` (icons/name/theme only —
no service worker yet, that's still M6). `brand/icon-source.svg` is a
raster source, intentionally not shipped. No emojis anywhere in the
product chrome, per the rebuild spec — audited clean.

### Persistent data model — the entire server-side store

`migrations/0001_init.sql` is the whole schema:

```sql
CREATE TABLE IF NOT EXISTS users (
	username           TEXT PRIMARY KEY NOT NULL,
	password_verifier  TEXT NOT NULL,
	identity_pubkey    TEXT,
	signed_prekey      TEXT,
	created_at         INTEGER NOT NULL
);
```

That's it — one table. This is the auditability claim the spec asks for:
if compelled to answer honestly and completely what the server stores,
the answer is exactly this file. `identity_pubkey` / `signed_prekey` are
nullable placeholders for Milestone 2 (X3DH); `one_time_prekeys` is **not**
created yet — an empty, unused table wouldn't be "minimal and auditable,"
so it's deferred to a `0002_prekeys.sql` migration when X3DH actually needs
it.

### Auth

`worker/auth.ts` + `worker/index.ts`. Username + password, no email/phone.

- **Hashing:** [`worker-password-auth`](https://github.com/jamesbirtles/worker-password-auth),
  a Rust `password_auth` crate (Argon2id, OWASP params, salt embedded in a
  PHC-format string) compiled to WASM. **Why not `hash-wasm`** (the spec's
  suggested "or similar"): `hash-wasm` compiles its WASM binary from a
  base64 blob *at call time*, and workerd disallows dynamic
  `WebAssembly.compile()`/`instantiate()` on runtime bytes — this is a
  platform-wide restriction (confirmed to fail identically in `vite dev`
  and in the vitest pool), not a local-dev quirk. `worker-password-auth`
  instead does a *static* ESM import of a precompiled `.wasm` file
  (`import wasm from './x.wasm'`), which Wrangler's bundler turns into a
  `WebAssembly.Module` at build time — instantiating an already-compiled
  module is allowed at runtime. This is the standard pattern for
  WASM-backed crypto on Workers.
- **Session token:** stateless, HMAC-SHA256 over `{sub, iat, exp}`
  (`base64url(payload).base64url(signature)`), signed with
  `env.SESSION_SECRET`. Deliberately **not** a general JWT — there's no
  header/alg to negotiate since signer and verifier are the same code, so
  there's no `alg:"none"`-style confusion to defend against either.
  15-minute TTL in M1 (no refresh flow yet).
- **Cookie, not header or localStorage token:** httpOnly + Secure +
  SameSite=Strict. The reason is the WebSocket handshake: a browser
  `WebSocket` constructor cannot set an `Authorization` header, so a
  header-based token would need a second, leakier auth path for `/ws`
  (query param or subprotocol, both of which land the token in logs). A
  cookie is sent automatically on the same-origin `/ws` upgrade request, so
  one mechanism covers both `/api/*` and `/ws`.
- `SESSION_SECRET` in `wrangler.jsonc` is a **placeholder** for local dev
  only — before any real deploy, replace it with `wrangler secret put
  SESSION_SECRET` and remove the `vars` entry. Never commit a production
  signing key.
- Passwords will do double duty in M2: the same raw password derives the
  local IndexedDB keystore key, but with a **separate** salt/KDF — never
  reuse the auth derivation for that. M1 doesn't implement the keystore at
  all; it just doesn't discard the password before that hook exists.

### Mailbox Durable Object

`worker/mailbox.ts` — one instance per user (`env.MAILBOX.getByName(username)`),
WebSocket + the Hibernation API (`ctx.acceptWebSocket`, `webSocketMessage`,
`webSocketClose`) so an idle connection costs nothing while the DO is
evicted from memory. **M1 is a pure echo relay** — no storage, no offline
queue, no delivery acks, no TTL. That's Milestone 3 (real 1:1 messaging
lifecycle). The point of M1 is narrower: prove the Worker → DO → WebSocket
wiring actually works, including auth (only a request carrying a valid
session cookie reaches `MAILBOX.getByName`).

### Theme — ponderance.dev visual language, `.dark` class mechanism kept

Design tokens (colors, fonts) are ported byte-for-byte from
`../ponderance/src/styles/global.css`. The **mechanism** is not: ponderance
toggles dark mode via a `[data-theme="dark"]` attribute; this app already
had a working toggle using a `.dark` class on `<html>`, driven by
`useThemeInternal` + `localStorage['theme-preference']`, defaulting to
light (no `prefers-color-scheme` fallback) — and the rebuild spec says to
keep that behavior. So `src/index.css` ports the token *values* into a
`.dark { ... }` block instead of `[data-theme="dark"]`. `public/theme-init.js`
(an external script — CSP is `script-src 'self'`, no inline) mirrors
`useThemeInternal`'s exact default logic so the pre-paint seed and React's
first render never disagree (a fallback to `prefers-color-scheme` in the
seed script, while the hook defaults to light, would cause a visible
flash the *other* direction on first load for dark-OS users).

Fonts (Bricolage Grotesque, Hanken Grotesk, IBM Plex Mono) are self-hosted
`.woff2` files copied from ponderance's `public/fonts/` — no Google Fonts,
no CDN, per invariant #7.

### Test harness

Vitest + `@cloudflare/vitest-pool-workers`, tests run inside the real
`workerd` runtime (not mocked). `test/setup.ts` re-applies
`migrations/0001_init.sql` in a `beforeEach` — the pool gives each test
isolated storage, so schema seeding has to be idempotent and re-run rather
than a one-time global setup (`CREATE TABLE IF NOT EXISTS` makes that
safe). One non-obvious gotcha: `D1Database.exec()` splits statements on
**newlines**, not semicolons or a real SQL parser — a pretty-printed
multi-line `CREATE TABLE` fails with "incomplete input"; `test/setup.ts`
flattens each statement to one line before calling `exec()`.

### What's deferred (as of M1)

No crypto (`@noble/*`, X3DH, Double Ratchet, encrypted keystore) — M2.
No offline queue / delivery acks / message deletion / safety numbers — M3.
No disappearing messages / panic wipe / media / voice notes / local
search — M4. No groups — M5. No PWA / push / transparency page / paper-fold
animation / session manager / decoy notifications — M6. No CSP/SRI/SW
pinning hardening pass or written threat model — M7. No live Cloudflare
deploy — a later step once M1+ are reviewed.

## Milestone 2 — Crypto core

`src/crypto/` — a pure TypeScript package, no UI, no network, no D1/Worker
wiring yet (that's M3, when sessions actually get established and
persisted). Implements X3DH (session establishment) and the Double Ratchet
(per-message encryption), built entirely on audited primitives:
`@noble/curves` (X25519, Ed25519), `@noble/ciphers` (ChaCha20-Poly1305),
`@noble/hashes` (HKDF, HMAC, SHA-256). No hand-rolled curve arithmetic or
AEADs anywhere in this module.

### Module layout

- `primitives.ts` — thin wrappers around the noble libraries; the only file
  that touches raw curve/cipher APIs.
- `x3dh.ts` — identity/signed-prekey/one-time-prekey generation, and
  `initiateX3DH`/`respondX3DH`, the initiator and responder halves of the
  handshake.
- `doubleRatchet.ts` — ratchet state init (`initRatchetAsInitiator` /
  `initRatchetAsResponder`) and `ratchetEncrypt`/`ratchetDecrypt`.
- `types.ts` — the shared type surface; `index.ts` re-exports the public API.

### X3DH — one deliberate deviation from Signal's exact construction

Signal's real implementation uses a single Curve25519 scalar for both
identity-key roles (signing and DH) via **XEdDSA**, a birational
Montgomery↔Edwards conversion described in a separate Signal spec. This
codebase uses **two ordinary keypairs** instead — an Ed25519 keypair for
signing the signed prekey, and a separate X25519 keypair for the DH steps.
XEdDSA is a distinct, security-sensitive construction that's easy to get
subtly wrong to reimplement from scratch; X3DH's security doesn't depend on
reusing one key for both roles — that's a bandwidth optimization Signal
made, not a protocol requirement. The cost is a marginally larger identity
bundle (two public keys instead of one). Otherwise this follows the
published X3DH spec exactly, including:

- Verifying the signed prekey's signature before doing anything else with
  a bundle (`initiateX3DH` throws if verification fails).
- The `F` constant (32 bytes of `0xFF`) prepended to the DH-output
  concatenation before hashing — defense-in-depth against small-subgroup
  attacks, on top of `@noble/curves` already rejecting low-order DH inputs
  at the primitive level.
- HKDF-SHA256 over `F || DH1 || DH2 || DH3 || [DH4]`, zero-filled salt,
  fixed info string, 32-byte output.

### Double Ratchet — one known gap

Implements the spec's `KDF_RK` / `KDF_CK` / `RatchetEncrypt` /
`RatchetDecrypt` / `SkipMessageKeys` / `DHRatchet` pseudocode directly,
including the bounded skipped-message-key cache (`maxSkip`, default 1000)
that lets out-of-order and dropped messages still decrypt correctly, and
the DH ratchet step that gives the session forward secrecy and
post-compromise self-healing.

**Not implemented: header encryption.** The rebuild brief calls it out as
optional ("if feasible"); it's a distinct construction (a second header-key
chain, encrypt-then-guess on the receive side) with real complexity of its
own. Headers here travel in the clear alongside ciphertext, but are still
authenticated — included in the AEAD associated data, so tampering breaks
decryption rather than silently succeeding. This is a tracked gap versus
the ideal spec (a hardening-pass candidate), not something papered over.

**Decryption is transactional.** The spec's prose is explicit: "if an
exception is raised (e.g., message authentication failure) then the
message is discarded and changes to the state object are discarded." An
earlier version of `ratchetDecrypt` mutated the real state (advancing the
receiving chain, evicting skipped-key cache entries) *before* the final
AEAD tag check — so a single corrupted or replayed packet would advance
the chain past a genuine message that hadn't arrived yet, permanently
wedging the session for everything after it. Caught by a targeted
regression test (corrupt a message, confirm it throws, then confirm the
*real* message right after it still decrypts) rather than the existing
roundtrip/tamper tests, which all stopped at "and it throws" without ever
sending a subsequent genuine message. Fixed by cloning the state, doing all
trial work (skip-cache inserts, a DH ratchet step, the chain advance) on
the clone, and only committing it back once the AEAD tag has verified.

### Test vector strategy — and why it isn't "the Signal spec's test vectors"

The rebuild brief asks to "wire up the X3DH and Double Ratchet test vectors
from the Signal specs." In practice, **Signal's published X3DH and Double
Ratchet specs don't include an official numeric test-vector suite** the way
RFC-style primitive specs do (there's no fixed "given these exact bytes,
expect this exact shared secret" table for either protocol). So the test
suite is layered instead:

- `primitives.test.ts` — real, byte-exact vectors pulled from primary
  sources and verified programmatically (not just eyeballed) before being
  hardcoded: RFC 7748 §6.1 (X25519 Alice/Bob), RFC 8032 §7.1 TEST 1
  (Ed25519 sign/verify), RFC 5869 Appendix A.1 Test Case 1 (HKDF-SHA256),
  plus AEAD roundtrip/tamper-detection sanity checks.
- `x3dh.test.ts` — protocol-level properties: both sides of a real
  handshake agree on the shared secret (with and without a one-time
  prekey), independent handshakes produce different secrets, and a
  tampered or wrongly-signed signed prekey is rejected.
- `doubleRatchet.test.ts` — protocol-level properties: basic and
  bidirectional roundtrips, out-of-order delivery, a permanently dropped
  message, the DoS guard on an implausible skip count, replay of an
  already-consumed message failing closed, header-tampering detection, and
  a multi-round conversation confirming the ratchet keypair actually
  rotates (the mechanism that gives post-compromise recovery its teeth —
  demonstrated structurally here, not as a formal security proof).

All 32 tests pass under `@cloudflare/vitest-pool-workers` (the same real
`workerd` runtime as the rest of the app, not a Node-only environment) —
`@noble/*` is pure JS/BigInt, no dynamic WASM, so it needed no special
handling there.

### What's deferred (as of M2)

No D1/Worker wiring for identity keys, prekey publication, or session
storage — M3 decides how `PreKeyBundle`s get serialized and exchanged. No
encrypted IndexedDB keystore (the password-derived local key store) — M3.
No safety numbers / QR verification, sender-keys for groups, or header
encryption — see the relevant milestones above.

## Milestone 3 — Real 1:1 messaging (vertical slice)

M3 is the biggest milestone so far — sessions, an encrypted local
keystore, server routing, and the UI all have to meet in the middle. Built
as a thin **vertical slice** first (add contact → X3DH → encrypt → send →
live-deliver → decrypt), deliberately deferring the offline-queue/ack/TTL
lifecycle, delivery-state UI, and safety numbers + QR to a follow-up pass —
each is called out below as a documented gap, not an oversight.

### The keystore-unlock gap, and why it needed a design decision

M1's `AuthContext` restores the logged-in username from an httpOnly cookie
on every fresh load (`GET /api/auth/me`) — but never retains the raw
password past the login/signup call. The M3 keystore key is *derived from*
that password. So a plain page reload has a valid server session and no way
to re-derive the local decryption key: server login and keystore unlock are
two genuinely separate steps, not one.

Resolved by caching the derived key in `sessionStorage` (survives a reload
of the same tab; dies on tab close; not shared across tabs) rather than
localStorage or nothing at all. `src/components/KeystoreUnlockGate.tsx`
renders a password re-prompt whenever `username` is known but no cached key
exists for this tab — verified in Playwright to trigger correctly for a
*second tab in the same browser profile* (shares cookies + IndexedDB, but
sessionStorage is genuinely per-tab) while a same-tab reload unlocks
silently.

**Known tradeoff, not revisited yet:** the derived key sits in
`sessionStorage` in plaintext for the tab's lifetime — readable by any
script-injection on the page, the same risk class as most client-side SPA
secrets. Flagged here for the M7 hardening pass (a Web Worker holding the
key outside the main JS realm is the likely fix), not silently accepted.

**New-device / cleared-storage handling:** if a login succeeds server-side
but this browser has no local identity for that username, the client
generates a *fresh* identity and re-publishes it (`src/keystore/index.ts`,
`AuthContext.tsx`'s `establishLocalIdentity`) — overwriting the old one.
This matches the spec's single-device-v1 stance (no key escrow, no
cross-device backup): existing contacts will see this user's safety number
change next time they message them. Verified in Playwright: a genuinely new
context correctly gets a fresh identity and an empty contact list; a second
tab in the *same* context correctly hits the unlock gate instead.

### `src/keystore/` — the encrypted local store

Three files, each with one job:

- `crypto.ts` — Argon2id key derivation via `hash-wasm`, and the AEAD
  envelope (ChaCha20-Poly1305, via the already-tested
  `src/crypto/primitives.ts`) everything else is encrypted with. **Why
  `hash-wasm` here but `worker-password-auth` on the server:** workerd
  disallows dynamic `WebAssembly.compile()` (M1's `worker/auth.ts`), but
  that restriction is workerd-specific — browsers impose no such limit, so
  `hash-wasm`'s dynamically-compiled Argon2id works fine client-side. This
  also needed its own KDF (not a hash-verification library): the keystore
  needs raw derived *key bytes*, not a PHC verification string. The salt is
  freshly random and separate from the server-side auth salt — "never reuse
  the auth derivation," per the rebuild brief. This file must never be
  imported from `worker/` or `shared/`, or the build resurrects the exact
  dynamic-WASM failure M1 already solved.
- `storage.ts` — a hand-rolled, minimal promisified IndexedDB wrapper (three
  flat object stores: identities, sessions, messages) — not worth pulling in
  a dependency for a handful of get/put/delete calls.
- `index.ts` — the public API: identity lifecycle (`hasLocalIdentity`,
  `createIdentity`, `unlock`), per-contact Double Ratchet session
  persistence (`saveSession`/`loadSession`, serialized separately from the
  identity document so a chatty conversation doesn't rewrite every other
  contact's data on each message), one-time-prekey-secret lookup for
  responding to a first message (`takeOneTimePreKeySecret` — a *second*,
  client-side no-reuse guarantee independent of the server's atomic
  delete-on-fetch), contacts, and decrypted message history.

### D1 + Worker: key publish/fetch (`worker/keys.ts`, `migrations/0002_prekeys.sql`)

`identity_pubkey` and `signed_prekey` (nullable single `TEXT` columns since
M1) now hold packed JSON — no schema change needed, just structured
content in columns already declared. `one_time_prekeys` is a new table, one
row per key, deleted the instant a bundle fetch consumes it.

**OPK consumption is atomic in one SQL round trip** — `DELETE FROM
one_time_prekeys WHERE id = (SELECT id ... ORDER BY id LIMIT 1) RETURNING
public_key` — not a separate SELECT-then-DELETE, which would let two
concurrent bundle fetches for the same user race onto the same key and
break X3DH's one-time-use guarantee. Verified with a concurrency test:
five simultaneous fetches against a pool of three keys yield exactly three
distinct keys and two `null`s, never a duplicate.

**Known, documented gap:** no rate-limiting on bundle lookups yet. Usernames
are meant to be looked-up-by-design here (that's the contact-discovery
model), so existence isn't the concern — lookup *speed* for enumeration is.
Deferred to the M7 hardening pass.

### Mailbox DO: from echo to real routing (`worker/mailbox.ts`)

M1's echo relay is gone. The Worker stamps a trusted `X-Authenticated-User`
header before forwarding a `/ws` upgrade into a user's mailbox DO — the DO
has no other way to learn which user it represents, and this header can't
be spoofed by the original client request because Durable Objects here have
no public URL of their own (only reachable via this Worker's own
`env.MAILBOX.getByName()` call). That identity is persisted via
`ws.serializeAttachment()`, not a plain instance field — a Hibernation-API
requirement, since the DO can be evicted from memory between messages and a
plain field wouldn't survive that eviction.

Sending routes DO-to-DO: the sender's own mailbox DO receives a `{type:
'send', to, ciphertext, header, x3dh?}` frame over its owner's WebSocket,
stamps `from`/`id`/`ts`, and forwards to the recipient's mailbox DO instance
via the same `MAILBOX` binding (`POST /deliver`, an internal path only ever
reached this way). If the recipient has a live socket, delivery is
immediate and nothing is persisted. Otherwise the envelope is stored
(`ctx.storage`) and flushed the moment the recipient's socket next connects.

**Offline-queue ordering is load-bearing, not cosmetic.** `ctx.storage.list()`
returns keys in ascending UTF-8 sort order, not insertion order — keying a
stored envelope purely by its random `id` would make flush order effectively
random relative to send order. That's not just a display-ordering nuisance:
X3DH handshake material rides only on a session's *first* message
(`src/lib/messaging.ts`), so if a later, handshake-less message flushed
*before* the one establishing the session, the recipient would have no
session to decrypt it with — and, once flushed, it's gone from the queue.
Fixed by keying each stored envelope as `envelope:{ts, zero-padded}:{id}`
(`worker/mailbox.ts`'s `envelopeStorageKey`) so lexicographic order matches
chronological send order; `Chat.tsx` additionally sorts by `ts` before
render as a second safety net. Caught in an advisor review, not by the
Playwright suite — the E2E tests only ever queued a single message, which
can't surface a reordering bug.

**Documented gaps, not oversights — deferred to a Phase 2 pass:**
delivery acks that gate queue deletion (today a queued envelope is deleted
the moment it's *flushed* to a reconnecting socket, not when the client
confirms it actually processed it — a connection drop between flush and
processing can still lose that one message), the 14-day hard TTL sweep, and
delivery-state feedback to the sender ("sent" vs "delivered" in the UI).

### X3DH ↔ wire format: the signing-key gap M2 didn't anticipate

M2 deliberately used two separate keypairs (X25519 DH + Ed25519 signing)
instead of Signal's single XEdDSA key. That decision has a real consequence
wiring it into a first message: X3DH itself only ever exchanges *DH* keys
over the wire, never signing keys (only the initiator verifies a signature,
using a signing key it already has from the bundle fetch). But the
responder still needs the initiator's signing key for its own contact
record — future safety-number display needs both halves of the initiator's
identity. `shared/types.ts`'s `X3dhHandshakeWire` carries
`initiatorIdentitySigningPublicKey` alongside the DH key and ephemeral key
to close that gap — plain identity metadata, not a handshake security
input, so no new verification step is needed to justify sending it.

The X3DH handshake material itself travels only on the *first*
Double-Ratchet message of a session (`src/lib/messaging.ts`'s
`ensureSession`/`encryptForSend`), matching the spec's "attach to the
initial message" design rather than a separate handshake round-trip.

### Verified end-to-end (Playwright, two isolated browser contexts)

Signup for two users, add-contact (X3DH handshake), live encrypted
send/receive in both directions, message history and session state
surviving a same-tab reload without re-prompting, a second tab in the same
profile correctly hitting the unlock gate (wrong password rejected, correct
password unlocked), and a genuinely new browser context correctly
generating a fresh identity with an empty contact list. Not exercised in
`@cloudflare/vitest-pool-workers` — that runtime has no IndexedDB, so
keystore persistence is Playwright-only by necessity; protocol-level
worker/DO behavior (key publish/fetch atomicity, live + queued mailbox
delivery) has its own vitest-pool-workers coverage instead
(`test/keys.test.ts`, `test/mailbox.test.ts`).

## Milestone 3 Phase 2 — delivery lifecycle, rate-limiting, verification

Everything the M3 vertical slice deferred, now built.

### At-least-once delivery with idempotent receive

Queue deletion is now gated on a client **ack**, not on the flush attempt —
so a drop between flush and processing can no longer lose a message
(`worker/mailbox.ts`, `src/lib/messaging.ts`). The cost of that guarantee is
that a message can be delivered more than once (ack lost, or a reconnect
mid-flush), which flips delivery from at-most-once to at-least-once. That is
only safe because receive is **idempotent**:

- Every inbound id the client reaches a *terminal* decision on (decrypted,
  or permanently undecryptable) is recorded in a `processed` IndexedDB store
  (`markProcessed`/`isProcessed`). A redelivery is recognized and skipped —
  critical, because replaying an already-consumed message into the Double
  Ratchet fails closed (the "fails closed on replay" property from M2) and
  would otherwise loop forever, one error toast per reconnect.
- A duplicate is still **re-acked** — otherwise the server never clears it.
- `decryptIncoming` returns one of four outcomes; the caller acks the three
  *terminal* ones (`ok`, `duplicate`, `failed`) and deliberately does NOT
  ack `retry` (a message that arrived before its session-establishing
  handshake — left queued for redelivery after the handshake lands).

This whole shape was the single biggest design risk in the batch, flagged in
advisor review before implementation: naively ack-gating deletion without
idempotent receive makes delivery *worse*, not better.

**Every session-touching op is serialized onto one chain.** Both inbound
decrypt and outbound encrypt do `loadSession → mutate → saveSession` against
IndexedDB, and `saveSession` rewrites the *whole* record — so any two
overlapping ops clobber each other's ratchet state (benign within one chain,
but permanently wedging across a DH-ratchet step). `Chat.tsx` routes
everything — each inbound frame AND each outbound send — through a single
`sessionOpChain` (`enqueueSessionOp`), so ops are atomic and ordered. Two
distinct races made this necessary, each invisible to the other's test:
- **receive/receive** — `flushQueued` sends the whole offline queue
  back-to-back on reconnect; processing concurrently, the later messages
  loaded the session before the first's save landed, saw none, and requeued
  (a multi-message batch delivered only its first message per reconnect).
  Caught by a five-message-burst test.
- **send/receive** — a send crossing an inbound decrypt when both people
  type at once; the losing whole-record write reverts the other path's chain
  advance.

The chain tail never rejects (one failed op must not poison later ones), but
`enqueueSessionOp` returns the op's own promise, so a failed send still
surfaces its error to the message input. Mirrors the sender-side `sendChain`
in `worker/mailbox.ts`.

The `ack` also drives a best-effort, **live-only** `delivered` receipt back
to the sender (single-check "sent" → double-check "delivered" in the UI,
`MessageItem.tsx`). If the sender is offline when the receipt propagates it's
dropped, not queued — receipts are cosmetic, not durable.

### Send-order preservation without leaking precise time

The offline queue keys envelopes `envelope:{from}:{paddedSeq}:{id}`, where
`seq` is a per-sender monotonic counter assigned on the sender's DO (sends
are serialized through a promise chain so seq assignment and cross-DO
delivery stay strictly ordered). This preserves send order on flush — which
is load-bearing, since X3DH handshake material rides only on a session's
first message. The envelope's own `ts` is coarsened to the minute
(invariant #5); precise ordering lives in `seq`, not a wall-clock key.

### 14-day TTL sweep

A DO alarm (`worker/mailbox.ts`'s `alarm()`) deletes queued envelopes older
than 14 days regardless of delivery state (invariant #2). Alarms are
one-shot, so it reschedules itself while anything remains queued. Tested by
injecting an aged envelope via `runInDurableObject` and invoking the sweep.

### Bundle-lookup rate-limiting

A D1 fixed-window counter (`migrations/0003_rate_limits.sql`,
`checkRateLimit`) caps each authenticated requester at 30 bundle lookups per
60-second window, returning 429 past that. The limiter runs *before* the
existence check, so it throttles enumeration on both hits and misses. It's
honest about its limits: it caps how fast *one account* can enumerate, not a
determined attacker spinning up many accounts (that's account-creation's
problem, out of scope). Old windows are pruned opportunistically so the
table stays ~one row per active requester.

### Safety numbers, QR, and key-change detection

`src/crypto/safetyNumber.ts` computes a 60-digit fingerprint (iterated
SHA-512, Signal-style) that **commits to both** of a party's public keys —
the Ed25519 signing key *and* the X25519 DH key. This is the crux of the
two-keypair deviation: both keys authenticate the session, so a fingerprint
over only one would let an attacker swap the other undetected. The two
parties' fingerprints are ordered by byte comparison (not by role), so both
sides compute the identical number. Displayed as 12 digit-blocks on the
indigo verification panel plus an inline-SVG QR (rendered from the module
matrix as JSX `<rect>`s — no `dangerouslySetInnerHTML`). QR *scanning* uses
the native `BarcodeDetector` where available (dependency-free, graceful
"compare the digits" fallback elsewhere) and needs `camera=(self)` in the
CSP `_headers` — the scan path is Chromium-only and manual-test-only (real
camera required).

**Key-change *detection* is the security-critical half** — the warning is
worthless if nothing raises it. Sessions are sticky (once established, the
bundle is never re-fetched), so a contact who resets their identity and
messages you would otherwise hit a silent `ratchetDecrypt` failure, hiding
the change. The detection point is in `decryptIncoming`: when a **known**
contact sends fresh X3DH material whose identity differs from what's stored,
it's treated as a re-handshake — the old session is discarded, the new one
accepted, prior verification is cleared, and a non-dismissable-until-
acknowledged warning is raised (`recordKeyChange`, surfaced in the chat
header banner and contact list). Verified end-to-end in Playwright: a contact
"resetting" on a fresh browser context flips the other side to
warning + un-verified, and the re-handshake still decrypts.

**Known limitation — detection is one-directional.** It fires when the
*reset* party re-initiates (their new first message carries fresh X3DH that
differs from what the peer stored). The reverse case is not yet handled: if
Bob resets and then *Alice* (holding the old session) messages first, she
sends a normal no-handshake ratchet message; Bob's fresh keystore has no
session and no handshake material, so it lands as `retry` and requeues until
the 14-day TTL — undeliverable, with no warning on either side and Alice
stuck on "Sent." The proper fix is Signal-style **session-reset signaling**
(Bob, on an undecryptable message from a known-but-sessionless contact,
asks the sender to re-handshake). That's a protocol addition deferred to a
later milestone; called out here rather than left as a silent gap.

### Verified end-to-end (Playwright, two isolated browser contexts)

Two-user signup, add-contact (X3DH), live encrypted send/receive both ways,
history + session surviving a same-tab reload, the unlock gate for a second
tab, fresh-identity generation in a new context, the **ack-gated offline
queue** (message shows "Sent" while the recipient is offline, flushes and
flips to "Delivered" on their return), a **five-message offline burst** all
delivered in order on a single reconnect (the case that exposed the inbound
race), the **delivered receipt** for live messages, manual **safety-number
verification**, and **key-change detection** (reset identity → warning +
cleared verification on the peer).
Protocol-level worker/DO behavior — key publish/fetch atomicity,
rate-limiting, live + queued delivery, ack-deletion, delivered
notifications, TTL sweep — has vitest-pool-workers coverage
(`test/keys.test.ts`, `test/mailbox.test.ts`); the safety-number crypto has
unit tests (`src/crypto/safetyNumber.test.ts`). IndexedDB-bound keystore
behavior is Playwright-only by necessity (no IndexedDB in the Workers pool).

### What's deferred (beyond M3)

Session-reset signaling (so key-change detection works when the *non-reset*
party messages first — see the one-directional limitation above),
multi-device (v1 is single-device — the send-seq counter and the
"fresh identity on a new device" path both assume one socket per user),
key-change *history* timeline, and a `sessionStorage`-key hardening pass
(M7). Groups, PWA/push, and the transparency page remain their own later
milestones. The processed-id store isn't pruned yet (bounded in principle
by the 14-day TTL after which no redelivery occurs; a documented growth
caveat, not a leak).

## Milestone 4 — Features (disappearing messages, panic wipe, media, search)

The foundation for three of these four is one architectural change: **the
ratchet plaintext is now a typed envelope**, not raw text
(`src/lib/chatPayload.ts`). `encryptForSend` takes a `ChatPayload`
(`{t:'text'|'media'|'timer', …}`) and `decryptIncoming` parses and
dispatches it. Anything "negotiated inside the encrypted channel" — the
disappearing timer today, read receipts/typing later — is a payload variant
the server never sees, never a wire field. `decodeChatPayload` is tolerant
of pre-M4 raw-text bytes (treated as `{t:'text'}`), so the change is
backward compatible.

### Disappearing messages

Per-conversation timer (off / 1h / 1d / 1w) stored in the contact record and
synced to the peer by an in-channel `{t:'timer'}` control message (which
returns `status: 'control'` from `decryptIncoming` — terminal and acked, but
nothing to display). Each text/media message is stamped at send with its own
`expiresAt` derived from `sender-timestamp + timer`; a timer change applies
going forward only, never re-stamping history (Signal's model). Both sides
compute the same `expiresAt` (the sender's send time is carried in the
server-stamped `ts`), so a message vanishes from both devices at the same
wall-clock. A client-side sweep (`sweepExpiredMessages`, every 3s + render-
time filtering) prunes expired messages from the encrypted store *and* the
view — and takes any cached media bytes with it. Verified end-to-end with
Playwright's clock API fast-forwarded past a 1h expiry: gone from both sides
and from the store (survives reload).

### Panic wipe

A deliberate two-step control (header button or the unlock-screen link →
confirm dialog) plus a keyboard chord (triple-tap Escape within 1.5s). The
load-bearing constraint (from design review): it must work while the
keystore is **locked** and while **offline**. So `PanicWipe` is mounted
*above* the keystore-unlock gate (which otherwise renders only its own
screen), and every step of local destruction is key-independent and
network-independent: it deletes the entire keystore IndexedDB database
(`deleteKeystoreDatabase` — no decryption, all users), clears
session/localStorage, purges Cache Storage, and unregisters service workers.
The server logout is best-effort and never blocks. Verified in Playwright:
wipes fully from a locked second tab, and wipes fully while offline (the
local destruction completes even though the logout can't reach the server).

### Encrypted media + voice notes

A blob is encrypted client-side with a fresh random ChaCha20-Poly1305 key +
nonce (`src/lib/media.ts`); only the **ciphertext** is uploaded to R2
(`worker/media.ts`), and the `{id, key, nonce, digest}` travels inside the
E2EE message as a `MediaRef` — the server never sees a key, a filename, or a
MIME type. The `digest` (SHA-256 of the *ciphertext*) is verified before
decryption, so a swapped R2 object fails closed. Lifecycle mirrors the
message ack model: the recipient deletes the R2 object on fetch-ack, and a
14-day R2 lifecycle TTL is a deploy-time rule (documented; R2 lifecycle
rules aren't simulated by miniflare, so fetch-ack is the path that runs
locally). Because R2 ciphertext is deleted on fetch, both sides also cache
the decrypted bytes locally, **encrypted at rest** with the keystore key
(`MEDIA_CACHE_STORE`), so media re-shows after reload. Voice notes use
MediaRecorder (opus) → the same encrypt/upload path → an in-bubble `<audio>`
player; recording needs `microphone=(self)` in the CSP `_headers` (the
image/audio blob URLs need `img-src`/`media-src blob:`). Verified end-to-end
in Playwright: a sent image decrypts on the peer to its exact original
dimensions via a `blob:` URL (never a network image). The voice *recording*
path is manual-test-only (no real mic in the harness); its send path is
identical to images.

**The sender-supplied MIME type is never trusted for display.** A `blob:`
URL is same-origin, so a blob of `text/html` (or `image/svg+xml`) opened as a
top-level document would execute script in our origin — with access to the
`sessionStorage` keystore key. `MediaAttachment` therefore forces a safe Blob
type derived from `mediaKind`, not the ref's `mimeType`: images must declare a
known-inert *raster* type (SVG is rejected outright), voice must be `audio/*`,
and files are always `application/octet-stream` behind a `download` attribute
(never opened in a tab). Forcing the type means even HTML/SVG bytes are
interpreted inertly.

### Local-only search

Full-text search over decrypted history via MiniSearch. The index is built
**in memory** from `loadAllMessages` each time the dialog opens and discarded
on close — it is never written to IndexedDB (that would put plaintext at
rest, gutting the keystore-encryption model) and never leaves the device.
Verified in Playwright: relevant results returned, clicking one opens the
conversation, and **zero `/api/` requests fire during a search**.

### What's deferred (as of M4)

Everything from the M3 deferral list still stands. New this milestone:
media doesn't chunk/stream (whole-blob encrypt, 25 MiB ciphertext cap), no
in-bubble waveform rendering beyond the native audio control, and the
disappearing-timer change doesn't sync if the sender is offline at the
moment they change it (it applies locally and syncs on their next message).

## Milestone 5 — Groups (sender keys, vertical slice)

Groups use the **sender-key** construction, and the design turns on keeping
two mechanisms strictly separate (advisor-vetted before implementation):

1. **Sender-key distribution** — *pairwise*, over the existing Double
   Ratchet, as a `{t:'senderkey'}` `ChatPayload`. Forward-secret and
   authenticated by the 1:1 session. This is the bootstrap.
2. **Group content messages** — encrypted *once* with the sender's sender
   key (`src/crypto/senderKey.ts`: an HMAC hash-ratchet, same chain KDF as
   the Double Ratchet), **signed per-sender with a fresh Ed25519 key**, and
   fanned out to each member's mailbox as a distinct `WsGroupSendFrame` →
   `WsGroupMessageFrame`. No ratchet header, no X3DH.

**Per-sender signatures are mandatory, not optional.** In 1:1, shared-key
AEAD authenticates because only two parties hold the key. In a group *every*
member holds the sender's chain key, so AEAD alone would let any member forge
as any other. Each message is signed with a per-(sender, group) Ed25519 key
whose secret only the sender holds — verified *before* decryption. The
signing key is per-group (not the identity key) so it rotates on rekey and
leaking one group reveals nothing about others. `senderKey.test.ts` proves
the three group properties adversarially: a forged/re-signed message is
rejected, a late joiner can't read earlier messages (forward secrecy via the
one-way chain), and the skip bound caps DoS.

### Creator-relay distribution (v1 simplification)

The naive full mesh — every member distributes their sender key directly to
every other — makes non-creator pairs *mutually* initiate a pairwise session
at the same moment, which is X3DH **glare** (crossed handshakes). Glare is a
genuinely hard problem (Signal solves it with tie-breaking) and is deferred.
For the slice we sidestep it structurally: a **non-creator sends its sender
key only to the creator**, who **re-distributes** it to the rest (the
`senderkey` payload carries `sender` — the key's real owner — separately from
the message's `from`, so a relayed key is attributed correctly). No member
pair ever mutually initiates, so no glare. Group *content* messages still fan
out directly member-to-member (they need no pairwise session — the mailbox
just relays ciphertext). Trust note: a malicious creator could hand a member
the *wrong* sender key for a third party, but can't forge that party's
messages (the per-sender signature fails closed) — worst case is denial, not
impersonation. Full mesh + tie-breaking is the deferred upgrade.

### Two bugs the happy path hid (both caught in verification)

- **Re-entrant `enqueueSessionOp` self-deadlock.** Reciprocation runs inside
  an inbound handler that is *already* a task on the session-op chain; the
  original code enqueued *again* and awaited it, wedging the member's entire
  inbound pipeline the instant they reciprocated. The first 2-member test
  only checked creator→member (which is processed before the wedge), so it
  looked green. Fix: split every session op into a raw (non-enqueuing)
  internal and a thin enqueuing wrapper — on-chain callers use raw, top-level
  callers use the wrapper.
- **Creator missing from its own roster.** `createGroupLocal` stored only the
  *selected* members, so a member fanning out to "everyone but me" excluded
  the creator and silently never reached them. Fix: the roster always
  includes the creator.

Both are the same lesson as M3's concurrency work: a group happy-path test
that checks one direction hides the reverse. The committed verification now
drives all directions across a real 3-member group (create → converge →
every member sends, every other member receives).

### Group state & fan-out

Group metadata (name, members, creator) and per-group sender keys live only
in the encrypted keystore (`GROUP_STORE`, `GROUP_SENDER_STORE`,
`GROUP_RECEIVER_STORE`); the server sees only opaque group ids and per-member
mailbox fan-out. Fan-out is client-side: one logical send → N
`WsGroupSendFrame`s through the same `sessionOpChain`, delivered via the
existing mailbox (offline queue, ack-gated deletion, and dedup all apply
unchanged — a group message that arrives before its sender key returns
`retry` and is redelivered, exactly like the 1:1 handshake-before-message
ordering). Group conversations reuse the message-history store under a
`group:<id>` key. Groups are capped at 32 members (v1).

### Membership changes with rekey (add / remove)

Membership is **creator-authoritative** (v1): only the creator adds or
removes, and a membership-change control payload (`{t:'groupmembership'}`) is
accepted *only* when it arrives over the pairwise session whose `from` is the
group's creator — otherwise any member could forge "remove X." This
serializes membership changes (no concurrent-change reconciliation) and fits
the creator-relay distribution model.

**Add and remove are asymmetric:**
- **Add needs no rotation.** Forward secrecy already does the work — the
  distributed key is the current chain-key-at-current-iteration, so a new
  member can only go forward, never read pre-join messages
  (`senderKey.test.ts` proves this; the Playwright add test confirms it
  end-to-end). The creator relays every existing member's sender key to the
  newcomer and the newcomer's key back out.
- **Remove requires rotation, and rotation is the *only* security boundary.**
  Excluding the removed member from fan-out is NOT sufficient: they kept a
  copy of every member's chain key, and the hash ratchet lets them derive all
  *future* message keys from it (they can obtain ciphertexts out-of-band). So
  on removal every remaining member (including the creator) generates a
  **fresh** sender key and redistributes; the removed member's retained keys
  are then dead. This property is invisible to a happy-path UI test (a client
  just hides the group), so the gate is a **crypto-level** test
  (`senderKey.test.ts`): a retained `ReceiverSenderKeyState` *cannot* decrypt
  a message encrypted after the sender rotates. The Playwright test then
  confirms the wiring (remove a member → remaining members keep exchanging;
  the removed member receives nothing).

  **Removal secrecy is *eventual*, not instantaneous — and honestly so.**
  Rekey is asynchronous and the server is a dumb relay by design, so there is
  no synchronization barrier. A remaining member who is *offline (or lagging)
  at removal time* has not yet rotated and still lists the removed member in
  its local roster — so it keeps fanning out to them, encrypted with the
  un-rotated key that member retained and can still read, until it reconnects,
  processes the removal, and rotates. Removal is only as strong as the
  *slowest* remaining member's rotation (Signal has an analogous window). The
  reconnect self-heal rides the same seq-ordered offline queue + `retry` as
  everything else (the rotated key carries a lower seq than the messages after
  it, so it applies first) — but that offline-then-reconnect rekey path is
  *expected, not exercised* by a committed test. Also note the group *wiring*
  (fan-out, membership, rekey) has no committed regression test — only the
  crypto property in `senderKey.test.ts` is committed; the integration is
  Playwright-verified but ephemeral, so a future refactor could break group
  rekey with a green `npm test`.

**The creator is pinned, not rewritable.** A group's `creator` is fixed the
first time we learn the group (from a `senderkey` distribution whose `from`
is the claimed creator and whose roster includes us) and is *never* overwritten
by a later payload. Without this, any member could send a `senderkey` (or a
`groupmembership`) for an existing group carrying a forged `creator`/`members`
and take it over. So: a `senderkey` for an *existing* group installs only the
sender key and never touches metadata (and a non-creator only accepts key
relays that come *from* the pinned creator); a `groupmembership` is accepted
only for a group we already know and only from its pinned creator (no
"declare the creator of an unknown group" fallback). Roster changes flow
exclusively through the creator-authoritative `groupmembership` path.

**Two guards close the obvious holes:** a removed member who keeps posting is
rejected by a **roster check** in `decryptGroupMessage` (a message from a
non-member is ack-and-dropped, never left as a permanent `retry` that would
redeliver until the TTL); and the **creator can't be removed** (its relay
role would collapse distribution) — if the creator wants to leave, the group
is effectively retired (documented, not a silent code path).

### Group state & fan-out

Group metadata (name, members, creator) and per-group sender keys live only
in the encrypted keystore (`GROUP_STORE`, `GROUP_SENDER_STORE`,
`GROUP_RECEIVER_STORE`); the server sees only opaque group ids and per-member
mailbox fan-out. Fan-out is client-side: one logical send → N
`WsGroupSendFrame`s through the same `sessionOpChain`, delivered via the
existing mailbox (offline queue, ack-gated deletion, and dedup all apply
unchanged — a group message that arrives before its sender key returns
`retry` and is redelivered, exactly like the 1:1 handshake-before-message
ordering). Group conversations reuse the message-history store under a
`group:<id>` key. Groups are capped at 32 members (v1).

### What's deferred (as of M5)

Full-mesh distribution + X3DH glare tie-breaking (creator-relay is the v1
stand-in — it means the creator is a distribution single-point and can't be
removed). Non-creator-initiated membership changes. Group attachments (the
single-recipient fetch-ack R2 deletion model doesn't fit multi-recipient
media). Group disappearing-message timers. Everything from prior deferral
lists still stands.

## Milestone 6 — PWA, push, transparency, animation, session/decoy

### The production-build bug that dev-only testing hid (read this first)

M6 was the first milestone verified against `npm run build` + `vite preview`
instead of `vite dev`, on the advisor's insistence that a service worker
behaves differently in a bundled build. That immediately surfaced a bug that
would have broken the app *in production for every user*: the CSP
`script-src 'self'` blocks `hash-wasm`'s dynamic `WebAssembly.compile()` for
the client-side Argon2id keystore derivation, so signup/login (which derive
the keystore key) failed with a CSP violation. **`vite dev` doesn't enforce
the `_headers` CSP, so every prior milestone's dev testing passed while the
production build was silently broken.** Fixed by adding `'wasm-unsafe-eval'`
to `script-src` — the narrow directive that permits WebAssembly compilation
*without* enabling general `eval()`. Documented tradeoff: allowing WASM
compilation is required for browser-side Argon2id; `'wasm-unsafe-eval'` is
strictly narrower than `'unsafe-eval'`. Lesson banked: **the SW and CSP must
be verified against a production build, not dev.**

### PWA (service worker)

`public/sw.js` — deliberately minimal and auditable, registered
**production-only** (`import.meta.env.PROD` in `main.tsx`) so it never fights
Vite's dev HMR. It caches the **app shell only** (HTML/JS/CSS/fonts/icons):
navigations are network-first (a fresh deploy is picked up online, cache is
the offline fallback), content-hashed assets are cache-first (immutable). It
**never** touches `/api/*`, `/ws`, `/api/media/*`, non-GET, or cross-origin
requests — caching a token-bearing response or ciphertext would be a
data-at-rest leak, and caching `/ws` would kill live messaging. The cache is
versioned with `skipWaiting`/`clients.claim`. Offline read of already-decrypted
history works because history lives in IndexedDB; the app shell loads from
cache. Panic wipe already clears caches + unregisters the SW. This is the seam
M7's app-shell hash-pinning hardens — it's kept small and re-derivable on
purpose. Verified against `vite preview`: SW registers, app works, and the
shell loads offline while `/api/*` correctly fails (not served stale).

### Web Push — content-free by construction

The push is **payload-less**: a bare, VAPID-authenticated POST with no body —
no message text, no sender, nothing (`worker/push.ts`). The service worker's
`push` handler shows a generic notification titled with the user's own local
**decoy label**, and the app then fetches + decrypts on its own. There is
literally nothing in the push to leak — invariants #1 and #5 by construction.
VAPID signing is ES256 via WebCrypto, **not** the `web-push` npm library
(which needs Node's `crypto`/`https` and won't run on workerd — the same class
as the M1 hash-wasm restriction; verified WebCrypto ES256 JWT signing works in
the pool before building). Subscriptions store **only the endpoint** — not the
p256dh/auth payload-encryption keys, because there is no payload. The
endpoint is client-supplied and the worker fetches it, so it's an **SSRF**
vector if unchecked: it's validated against an allowlist of real push-service
hosts (FCM/Mozilla/Apple/WNS) on *both* the subscribe and send paths, and the
outbound wake-up fetch uses `redirect: 'manual'` so a 3xx can't redirect to
an internal target. The subscribe upsert also refuses to reassign an
endpoint's ownership to a different user (a conflict on someone else's row is
a no-op), so one account can't hijack another's subscription. Both are
regression-tested (`test/push.test.ts`). The mailbox
DO fires a wake-up when it queues a message for an offline recipient. Actual
delivery is deploy-only (needs a real push service + a live browser
subscription), but the security-critical property — that the wire request
carries no content — is unit-tested against `buildWakeupRequest`
(`test/push.test.ts`). VAPID private key is a `wrangler secret put` value in
production (placeholder locally, like `SESSION_SECRET`).

### /transparency page + schema-drift guard

`/transparency` (a public route) enumerates, specifically and completely,
every field the server persists — the four D1 tables (`users`,
`one_time_prekeys`, `rate_limits`, `push_subscriptions`) AND the Durable
Object storage (queued ciphertext + the send-seq counter, which isn't in D1
and is the easy thing to forget) — plus what a subpoena could compel and the
honest web-client caveat. It's driven by `src/data/serverState.ts`, and
`test/schema-drift.test.ts` parses the actual migrations and **fails the build
if the documented D1 tables/columns drift from the schema** — proven to bite
(adding a throwaway column without updating `serverState` breaks the test;
revert fixes it). DO storage carries no automated check (not in migrations) —
that's called out on the page.

### Paper-fold send animation

A ~300ms origami unfold on newly-appended message bubbles
(`.animate-paper-fold` in `index.css`, gated by `MessageList` to fire only for
messages added *after* the initial history load, not the whole history at
once). Purely cosmetic: it animates a transform over a bubble that's already
in the DOM, so it never gates the send or the local append. The global
`prefers-reduced-motion` reset collapses it to instant.

### Session manager + decoy notifications

The settings dialog shows the single (v1 single-device) session with its
sign-in time — read from the token's `iat` via `/api/auth/me`, no new
storage. The action is labelled **"Sign out," not "revoke,"** and the copy is
honest: signing out clears this device's session, but a stolen stateless token
still expires only on its own 15-minute TTL — there's no separate remote
revocation yet (that's multi-device work). The **decoy notification label**
(user-configurable, e.g. "Calendar") is stored in a cache the SW reads, so a
wake-up notification shows that innocuous label instead of anything
identifying FlatFold — shoulder-surfing protection.

### What's deferred (as of M6)

Real push *delivery* verification (deploy-only). Multi-device + true
server-side session revocation. App-shell hash pinning / SRI (M7). Reproducible
build documentation (M7). Everything from prior deferral lists still stands.

## Milestone 7 — Hardening

The final milestone: close the one invariant with no enforcing code, throttle
the brute-force surface, tighten the CSP, and write the honest security
capstone. Full detail lives in `docs/THREAT_MODEL.md`; this section is the
what-changed.

### Account deletion (invariant #6 — the real build)

`worker/account.ts` `handleDeleteAccount` requires **password re-auth** (not
just the session cookie — deletion is irreversible, and a stolen 15-minute
session must not be able to nuke the account). It then, synchronously:
purges the user's mailbox DO (`worker/mailbox.ts` `handlePurge` —
`storage.deleteAll()`, cancels the TTL alarm, closes the socket) and deletes
every D1 row in one atomic batch (`worker/db.ts` `deleteUserData` — `users`,
`one_time_prekeys`, `push_subscriptions`, `rate_limits`). The client wipes its
own keystore via `panicWipe`. Two deliberate scoping decisions, both
documented as honest tradeoffs: envelopes this user *sent* into *other* users'
mailboxes aren't deleted (they're the recipients' ciphertext, not this
user's), and **R2 media isn't deleted** — there's deliberately no
server-side user→media index (that would undercut invariant #5's
metadata-minimization), so uploaded media is unenumerable ciphertext bounded
by fetch-ack + the R2 TTL. `test/account.test.ts` proves the D1 rows and DO
storage are gone, re-login fails, and password re-auth is required.

### Auth rate limiting

Login is the online password-guessing surface, so `handleLogin` throttles per
**target username** (10 / 5 min) — reusing the `rate_limits` machinery — and
`handleSignup` throttles per attempted username (5 / hour). Keyed by username,
not IP, because FlatFold deliberately doesn't log IPs (invariant #5); the
documented tradeoffs are a possible ~5-minute login-lockout DoS against a
known username and no cross-username signup-spam throttle (that needs IPs).
`test/rate-limit.test.ts` proves the 11th login attempt is `429` and that
throttling is per-username (a bystander account is unaffected).

### CSP tightened, SW/SRI reasoned

Dropped `'unsafe-inline'` from `style-src` entirely after converting the one
remaining React `style={{}}` to utility classes — Tailwind v4 emits a linked
stylesheet, so `style-src 'self'` holds. Verified against `vite preview`
(the CSP isn't enforced under `vite dev`): zero CSP violations, styling
intact. `script-src` stays `'self' 'wasm-unsafe-eval'` (WASM Argon2id needs
the narrow wasm directive; still no general `eval`). SRI was deliberately
**not** added (marginal for a same-origin bundle — the server controls both
the HTML and any integrity hash); the service worker's cache-first-for-
immutable-assets *is* the substantive integrity control (first-seen-wins
pinning), with the unbootstrappable entry-HTML limit documented rather than
papered over. See `docs/THREAT_MODEL.md` §2.

### Dependency audit

`npm audit` was clean-able: bumped `react-router-dom` 7.9.4 → 7.18.1 to clear
two high advisories — all in RSC/SSR/single-fetch/server-action code paths
this client-only `BrowserRouter` SPA never executes, so low real exposure,
but patched regardless. `npm audit` now reports 0 vulnerabilities.

### Threat model + invariant self-review

`docs/THREAT_MODEL.md` is the capstone: what the server can and can't see,
the web-client bootstrap caveat, adversary models, a numbered residual-risk
list, and a per-invariant self-review ({quote → enforcing code → test →
residual}). It states plainly that the two residuals a security-conscious
user should weigh are **(a) the communication graph + timing are visible to
the server** (invariant #5 met in letter — no server-side contact lists — but
not in spirit; no sealed sender) and **(b) the web-client bootstrap** (the
server ships the JS). These are structural to a serverless web messenger and
are disclosed to users on `/transparency`, not hidden behind a checkmark.

## Sealed sender (post-M7, incremental) — increments 1–2

Sealed sender hides the message *sender* from the server (recipient + timing
stay visible, as in Signal). It's built as a numbered sequence (`docs/SEALED_SENDER.md`);
it is **not active yet** — no message is sealed end-to-end until the client
sealed-send path and the from-less receive-path rework land (increments 4–5).
The social-graph residual in `docs/THREAT_MODEL.md` §1 is therefore unchanged.

### Increment 1 — OHTTP gateway (`worker/seal.ts`)

`POST /api/seal` (unauthenticated — the sender is never identified) decapsulates
an HPKE-sealed `{recipient, token, envelope}` (via `@hpke/core`, DHKEM-P256 /
HKDF-SHA256 / AES-128-GCM) and routes it to the recipient's mailbox DO. All
failure paths return a uniform `202` so the endpoint is not an oracle for valid
recipients/tokens. `GET /api/seal/keys` publishes the gateway's (non-secret)
public key. The DO's `handleSealedDeliver` validates the token and queues a
**from-less** envelope under a receive-order key (`envelope:{recvSeq}:{id}`), so
sealed sends carry no per-sender ordering the way the legacy `envelope:{from}:…`
path does — per-sender order is the ratchet's job, cross-sender order is
irrelevant.

### Increment 2 — delivery tokens

Each account has one **delivery token** — a random ≥16-char string others
present to reach it on the sealed path. **It is per-recipient shared** (one
token all my contacts use); a per-contact token would re-identify the sender to
my DO. Crucially, **the token is public**: it rides the (first-contact-fetchable)
prekey bundle, so rotation is anti-spam / passive-cutoff hygiene, **not**
cryptographic access control — stated honestly in the threat model, not sold as
a capability.

Two server stores must agree, and one endpoint is the single writer:
`POST /api/seal/register-token` (authenticated) writes the **DO validator set
first** (`sealTokens`, newest-first, capped at 3 for a rotation grace window),
then the **D1 bundle copy** (`users.seal_token`, migration `0005`) only if the
DO accepted. That order is the crash-safe one — a bundle token the DO rejects
would break first-contact, whereas a DO token not yet in the bundle just isn't
handed out yet. Publish (`/api/keys/publish`) deliberately does **not** carry
the token: it also INSERTs one-time prekeys, so it's a poor vehicle for token
updates (would pile up OPKs on rotation).

Client wiring reuses the M5 sender-key rotation shape. `src/lib/sealToken.ts`
generates the token; a new `{t:'deliverytoken'}` `ChatPayload` distributes it to
existing contacts over their 1:1 ratchet (forward-secretly), stored per-contact
in the keystore (`savePeerSealToken`) so a future sealed send can present it. On
connect, `Chat.tsx` ensures the token exists and re-registers it (idempotent
convergence); on first creation it distributes to existing contacts. Removing a
1:1 contact (new conversation-header overflow menu → `keystore.removeContact`)
**rotates** the token, re-registers it, purges local conversation state, and
redistributes the fresh token to the remaining contacts — mirroring group
member-removal. The delivery token and the DO's receive-sequence counter are now
enumerated on `/transparency` (`src/data/serverState.ts`).

Verification is unit + DO/D1 level (`test/seal.test.ts` dual-store write +
grace-window eviction; `test/keys.test.ts` bundle field; `src/lib/sealToken.test.ts`;
`chatPayload` round-trip) plus live two-user checks; "a sealed send actually
*uses* the token" can't be exercised until increments 4–5.

### Increment 3 — anonymous bundle fetch (mechanism only)

Lets a first-contact initiator fetch a peer's bundle (+ delivery token) over the
OHTTP gateway **without the server learning who is asking** — the request is
HPKE-encapsulated and posted with no session cookie. **Mechanism only:** it is
built and tested but deliberately NOT yet wired into `ensureSession`. Flipping it
while the first message *send* is still `from`-stamped (sealed send = increment
4) would add zero privacy while losing OPK consumption + the requester rate limit
for everyone; anonymous-fetch and sealed-send wire together, end-to-end testable,
in increment 4.

The **response** can't use HPKE directly: `@hpke/core`'s `RecipientContext.seal()`
throws `NotSupportedError` at runtime (the TS types wrongly allow it). What both
contexts expose is a working `export()` (RFC 9180 §5.4). So the bundle is sealed
back with the **RFC 9458 §4.4 encapsulated-response construction** — an exporter
secret + a manual AES-128-GCM AEAD — pinned in `shared/sealedResponse.ts`
(`sealResponse`/`openResponse`, HKDF-Extract/Expand over `salt = enc‖response_nonce`,
plaintext padded to a fixed 1024 bytes). The gateway (`worker/seal.ts`) gains an
`op:'fetchBundle'` branch that looks the bundle up via `lookupBundleForSeal`
(`worker/keys.ts`) — which **skips OPK consumption and the requester rate limit**
(no authenticated actor to key on; an anonymous OPK consume would let anyone
drain a victim's pool) — and returns a length-uniform sealed body; an unknown
user yields a sealed, same-length "not found" sentinel, never a distinguishable
404. A **blunt global fixed-window throttle** (`ANON_FETCH_GLOBAL_LIMIT`, 120/60s)
guards the endpoint as defense-in-depth before a relay exists — over the cap it
returns a uniform empty 202 (global, so it's not a per-target existence oracle);
the real per-actor throttle belongs at the deferred relay. Client: `src/lib/sealedFetch.ts` `apiFetchBundleAnonymous` — written but
**not called anywhere yet**; its own body (credentials-omit fetch, parse
branching) is first *executed* when increment 4 wires it into `ensureSession`
and drives it live. No-OPK X3DH is fully supported, so a signed-prekey-only
bundle yields a working session.

Tests verify the **shared crypto + gateway end-to-end** (not the client wrapper
function, which is a separate first-execution in increment 4):
`test/sealedResponse.test.ts` (seal→open round trip, tamper/­wrong-key rejection,
length uniformity) and `test/seal.test.ts` increment-3 block (round-trip
bundle+token, no-OPK-drain, length-uniform not-found, unpublished == not-found).

### Increment 5 — ongoing-session sealed messaging

Actually sends messages sender-hidden — for **established sessions** only.
First contact still uses the normal, server-attested path (sealing a first
message would let a token-holder spoof a name; that's a deliberate follow-up with
bundle-key verification). The split keeps the peak-risk receive rework decoupled
from the first-contact-auth change.

- **Send (dual-path, `Chat.tsx` `sendPayloadRaw`)**: encrypt ONCE via the ratchet,
  then choose transport. For an established session (no pending handshake) where
  we hold the peer's delivery token, build a **from-less** `WsMessageFrame`
  (`sealedEnvelopeFromSend` — same ciphertext/header, client-stamped minute ts, no
  `from`/`seq`) and `apiSealedSend` it through the gateway. Any failure falls back
  to a normal WS send of the *same* frame (never re-encrypt — that desyncs the
  chain). Fallback reveals the sender: a privacy downgrade, surfaced here, not
  silently preferred.
- **Receive (`messaging.ts` `decryptIncoming`)**: unified over both wire shapes.
  With `frame.from` → the normal fast path. Without it → `trialDecryptSealed`
  tries each session via `tryRatchetDecrypt` (real clone-and-decrypt, not a
  header-only peek — catches skipped-key stragglers); the session whose header key
  decrypts IS the cryptographically-authenticated sender (its ratchet keys are
  exclusive to that contact). Header-mismatch → try next; header-match-but-AEAD-
  fail → fail closed (corruption on the identified session). Nothing matches →
  `retry` (out-of-order or junk). All downstream logic keys on the *identified*
  sender, not `frame.from`.
- **From-less ack (`worker/mailbox.ts` `handleAck`)**: a sealed message's ack
  carries no `to` (we don't know the sender), so the DO deletes our own queued
  copy and skips the reverse hop — otherwise a sealed offline message would
  redeliver until the 14-day TTL. Delivered *receipts* over the sealed path are a
  later increment.
- **Key-change** still fires: a re-handshake carries x3dh, so it's never sealed
  (sealing is gated on an established, no-pending-handshake session) and lands on
  the normal path where detection runs.

Verified: `tryRatchetDecrypt` crypto tests (right/wrong-session/corruption),
`test/seal.test.ts` from-less-ack deletion, and **live two-user** — an ongoing
sealed message decrypts with correct trial-decrypt attribution and no data loss.
The live-socket delivery path (`handleSealedDeliver` → `ws.send`) hits the same
`decryptIncoming` from-less branch as the offline flush that was driven live, so
it's covered by equivalence rather than separately exercised.

Two residuals to state honestly:
- **Ordering-retry** (advisor-accepted): a sealed message queued *ahead of* its
  session-establishing handshake flushes first (its numeric `recvSeq` key sorts
  before the legacy `envelope:{from}:…` key), hits `retry`, and arrives on the
  next reconnect — correct via the M3 retry machinery, never lost. Unifying the
  offline-queue key onto `recvSeq` for both paths would remove even that delay (a
  follow-up).
- **Silent drop on a stale token** (⚠️ the important one): the gateway returns a
  uniform 202 for *every* sealed POST (deliberately non-oracle), so `apiSealedSend`
  can't tell "delivered" from "recipient's DO rejected the token (403) and queued
  nothing." It reports success on 202, so there's **no WS fallback** and the
  message can vanish while the sender's own view shows it sent. This happens only
  when the stored peer token is stale — the recipient rotated past the 3-slot
  grace window (e.g. after contact removals), or an `{t:'deliverytoken'}` update
  was missed. There is no delivered-receipt for a sealed message yet, so the
  sender gets no signal either way. **This makes increment 6's sealed
  delivered-receipt load-bearing, not cosmetic** — it's the mechanism that lets a
  sender detect the drop (and could drive a re-send or a token refresh). Until
  then, sealed sends are best-effort-unconfirmed; documented, not silently
  assumed delivered. See `docs/THREAT_MODEL.md` for the three residuals this surfaces
(anonymous enumeration, first-message FS downgrade, response-size metadata) —
they bite at the increment-4 flip.

## Message ordering — the sender's clock, carried E2EE

Sent and received messages used to be timestamped at *different precisions* and
then sorted together, so messages within one minute rendered in arrival order
rather than send order:

- a **sent** message was stamped `Date.now()` (millisecond) by the optimistic
  local copy in `Chat.tsx`;
- a **received** message was stamped with the envelope `ts`, which
  `worker/mailbox.ts` coarsens to the minute for privacy (invariant #5, and the
  /transparency claim that the server only ever holds minute-granularity time).

Every received message therefore collapsed to `:00.000` and sorted ahead of
same-minute sent messages, with same-minute receives tying at the boundary and
falling back to arrival order. Making the *server* timestamp precise would fix
the ordering but break invariant #5, so it wasn't an option.

Instead the sender tells the recipient the exact send time **end-to-end**:
`sentAt` (ms epoch) is an optional field on the `text` and `media` variants of
`ChatPayload` (`src/lib/chatPayload.ts`), so it rides inside the AEAD ciphertext
the server never decrypts. Receivers order by `displayTsFor(payload.sentAt,
frame.ts)` (`src/lib/messageOrder.ts`) on both the 1:1 and group paths. The
envelope stays minute-coarsened and the server learns nothing new — pinned by a
regression test in `test/message-ordering.test.ts` that asserts `sentAt` appears
nowhere in the server-visible envelope.

Deliberate details:

- **`?? frame.ts` fallback.** Payloads without `sentAt` (legacy senders,
  in-flight messages) degrade to the old minute-collapse behavior, and only
  those.
- **Expiry still keys off `frame.ts`.** Disappearing-message expiry is
  intentionally approximate and must not depend on the sender's clock.
- **No new precision is displayed.** `formatTimestamp` / `formatListTimestamp`
  still render `H:MM`; `sentAt` is a sort key only.
- **Accepted tradeoff:** ordering now follows the **sender's** clock, the same
  model Signal and iMessage use. Clock skew between two devices can still
  misorder two messages sent within a few seconds of each other across users.
  That is the standard, accepted limit and is far better than the minute
  collapse. A server-side global order is *not* the fix — it would require the
  precise server timestamps FlatFold deliberately doesn't keep.

## Composer focus after send

The caret used to leave the composer on every send. `MessageInput`'s `<textarea>`
had no ref and carried `disabled={disabled || sending || recording}`, so
`setSending(true)` disabled the field mid-send — which **blurs it**, dropping the
mobile keyboard — and nothing refocused it when `sending` cleared. You had to tap
back into the box for each message.

The fix stops disabling the field rather than trying to restore focus after the
fact:

- the textarea is `disabled={disabled || recording}` — `sending` no longer locks
  it. Sends are optimistic and near-instant, so there was nothing worth locking,
  and keeping the field enabled is what keeps the mobile keyboard up;
- `handleSubmit` calls `textareaRef.current?.focus()` synchronously on success,
  inside the submit handler's user-gesture context (that's the part mobile
  Safari/Chrome require to reopen the keyboard). It's usually a no-op, but it
  matters when the user tapped the Send button, which moves focus to the button;
- the double-submit race that the `disabled` attribute used to cover is now held
  by a `sendingRef` guard.

**Why a ref and not the `sending` state.** Two synchronous submits (Enter held
down, a double-tap on Send) both run before React re-renders, so both read the
same stale `sending === false` from the memoized closure and `onSendMessage`
fires twice. A ref mutates immediately, so the second submit sees the guard. This
is verified, not assumed: `test-ui/MessageInput.test.tsx` fires two synchronous
`requestSubmit()` calls, and the state-based guard fails that test where the ref
guard passes.

### Test layout

Component behavior like focus is only observable in a DOM, but the suite runs in
the Workers runtime. `vitest.config.ts` therefore defines two projects:

- **`worker`** — the existing `@cloudflare/vitest-pool-workers` pool, covering
  `test/**` (worker + DO integration) and `src/**/*.test.ts` (co-located unit
  tests). Unchanged in behavior. Note it has no DOM, so a test here can only
  import *leaf* modules from `src/` — anything reaching `keystore/storage.ts`
  (IndexedDB) or `lib/api.ts` (DOM `fetch`) will not typecheck against the
  worker types.
- **`ui`** — jsdom, covering `test-ui/**/*.test.tsx`. `test-ui/` sits outside
  `src/` on purpose so component tests never enter the app build path or the
  Vite bundle; it has its own `tsconfig.json` wired into the root project
  references.
