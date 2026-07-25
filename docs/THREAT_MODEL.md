# FlatFold Threat Model

This document states, as plainly and completely as it can, what FlatFold
protects, what it does **not**, and, in the self-review at the end, quotes
each of the seven non-negotiable invariants the project was built against and
points to the code that enforces it (or honestly marks the gap). It is
written to be checkable, not reassuring. Where a control is partial, it says
so; a threat model that marks everything "✓" is worthless.

FlatFold is deployed at https://flatfold.ponderance.dev. Some controls are
enforced only in production (the `_headers` CSP, HSTS) and are verified
against the built site (`npm run build` + `vite preview`, or the live
deploy), not `vite dev`.

---

## 1. What the server is, and what it can see

The server is a Cloudflare Worker + Durable Objects + D1 + R2. It is a
**dumb relay by design**: it moves opaque ciphertext between mailboxes and
stores the minimum needed to do that. It never holds a decryption key.

**The server CAN see:**

- **The social graph and timing (the biggest residual).** Message delivery is
  routed to the *recipient's* mailbox DO (`worker/mailbox.ts` `deliverTo`), so the
  server observes *who receives, and when*, even though it cannot read *what*.
  Group messages fan out to each member's mailbox, revealing group membership by
  traffic pattern. Content is encrypted; the communication metadata is not.
  **Sealed sender (now deployed) hides the *sender* half:** on an established
  session, a message is HPKE-encrypted to the gateway and routed through an
  OHTTP relay run by an **independent organization** (Oblivious Network LLC), so
  the server learns "a valid-token message arrived for B" but not who sent it or
  from what IP — the relay sees the IP but not the content, the gateway sees the
  content but not the IP, and neither alone can rejoin them. This raises
  sender-correlation from *trivial* (IP + a server-stamped sender) to *statistical*.
  It does **not** eliminate it: the recipient's own authenticated receive
  connection still reveals their presence and IP, so "sends to B happen while A is
  online" re-links senders over time. Assume an adversary observing the server
  still infers your contact graph and activity times (coarsened to the minute)
  statistically. This remains the single most important limitation on this page.
- Usernames, registration times (minute-coarsened), and public key material —
  all public by design (needed to find and message someone).
- Ciphertext envelopes for *offline* recipients, transiently (see invariant
  #2), and encrypted media ciphertext in R2 (deleted on fetch-ack).
- Push subscription endpoints (opaque push-service URLs) for users who
  enabled notifications — tied to a username.
- Message sizes only at bucket granularity (payloads are length-padded — see
  invariant #1); the R2 media blob size still leaks separately.
- **Connection IPs — at the platform layer, not the application.** The
  *application* logs no IPs anywhere (invariant #5), but Cloudflare's edge
  necessarily sees the connecting IP of every request, outside the app's
  control. "No IP logging" means *we* don't record or use it; it does not
  mean your IP is invisible to the infrastructure.

**The server CANNOT see:** message plaintext, media plaintext, private keys,
contact lists (they live only in the client's encrypted keystore), read
receipts, or typing state (neither is implemented or persisted).

---

## 2. The web-client trust caveat (stated plainly, not papered over)

**A web app's E2EE is weaker than a native app's, because the same server
that relays your ciphertext also ships you the JavaScript that encrypts it.**
A compromised or coerced server could serve malicious JS on any visit. This
is a real, structural limitation — not something a service worker can fully
escape, because the service worker is *itself* served by that same server.

What we do about it, and the honest limits of each:

- **Strict CSP** (`public/_headers`): `default-src 'none'`,
  `script-src 'self' 'wasm-unsafe-eval'`, `style-src 'self'` (no
  `'unsafe-inline'`), `connect-src 'self'`, `object-src 'none'`,
  `frame-ancestors 'none'`, `base-uri 'none'`. This blocks injected inline
  scripts, third-party scripts, and exfiltration to other origins — so an
  XSS foothold can't trivially phone home. Two deliberate relaxations, both
  *style/wasm only, never script*: `'wasm-unsafe-eval'` is required for the
  browser-side Argon2id keystore-key derivation (`hash-wasm` compiles WASM at
  runtime); it permits WebAssembly compilation but not general `eval()`.
  `style-src` was tightened to drop `'unsafe-inline'` entirely in M7 after
  eliminating the last inline style.
- **Service worker app-shell pinning** (`public/sw.js`): content-hashed asset
  bundles are cached **first-seen-wins** (cache-first for immutable
  `/assets/*` URLs), so once you've loaded a good build, those exact asset
  URLs are pinned to the bytes you first received; a tampered re-serve of the
  same URL is never fetched. **The honest limit:** the entry document
  (`index.html`) is network-first and is the unavoidable *bootstrap trust
  root* — the SW cannot distinguish a legitimate new deploy from a malicious
  one, because both arrive from the same server. "Alert on app-shell change"
  would false-positive on every deploy; pretending otherwise would be the
  exact dishonesty this page exists to avoid.
- **Subresource Integrity (SRI):** deliberately *not* added, and here's why:
  SRI protects against a *third-party* host (e.g. a CDN) serving a different
  script than the page author intended. FlatFold serves everything
  same-origin from the one server that is also the threat — that server
  controls both the HTML and any integrity hash in it, so SRI buys nothing
  here. The SW first-seen pinning is the substantive integrity control; SRI
  would be security theater.
- **Reproducible builds:** the client is a standard `vite build` with pinned
  dependencies (`package-lock.json`) and no postinstall codegen beyond
  `wrangler types`. A determined auditor can rebuild and diff. (Byte-for-byte
  reproducibility is not yet asserted end-to-end — a documented gap.)

**Bottom line:** if your adversary is the server operator, FlatFold-web
raises the cost of an attack (it must be active and detectable, not passive)
but cannot make it impossible. For that threat, a client that is
independently distributed and verifiable (a native or extension build) is the
right tool. The `/transparency` page says this to users directly.

---

## 3. Adversary models

- **Passive network observer:** sees only TLS to one origin. HSTS +
  `upgrade-insecure-requests`. Cannot read content; can infer activity timing
  from traffic. Mitigated by TLS; graph/timing residual as in §1.
- **The server (honest-but-curious or compelled):** sees §1. Cannot decrypt.
  Can, in principle, ship malicious JS (§2). Account deletion (#6) means a
  compulsion order finds very little at rest.
- **Device thief (locked keystore):** the IndexedDB keystore is encrypted at
  rest with an Argon2id-derived key; without the password it's opaque. The
  password-derived key is cached in `sessionStorage` while a tab is unlocked
  (residual — see #3 below). Panic wipe works while locked and offline.
- **Malicious group member:** cannot forge messages as another member (every
  group message is per-sender Ed25519-signed, verified before decrypt —
  `src/crypto/senderKey.ts`). A removed member is locked out once remaining
  members rotate (eventual, not instant — see M5 docs). The group *creator*
  is trusted to relay sender keys honestly (creator-relay v1); a malicious
  creator can deny service (hand a wrong key) but cannot impersonate (the
  signature still fails closed).
- **Attacker with a stolen session cookie:** can read/send as the user until
  the session is revoked or expires, but **cannot delete the account** (that
  requires password re-auth — `worker/account.ts`). Sessions are long-lived
  and sliding (14-day idle), which is safe because server-side revocation
  exists: a per-user `token_epoch` is folded into every token and checked on
  each request (`worker/index.ts`), and "Sign out everywhere"
  (`POST /api/auth/logout-all`) bumps it to invalidate every outstanding token
  instantly.

---

## 4. Residual risks & known limitations (the honest list)

1. **Communication graph + timing are visible to the server** (§1). Sealed
   sender (deployed) hides the *sender* half via an independent-operator OHTTP
   relay, but the recipient's authenticated receive connection still reveals
   presence, IP, and timing, so the contact graph and activity times remain
   statistically inferable. The most significant limitation.
2. **Keystore key in memory (improved M7):** the password-derived key is now
   held ONLY in a module-scoped in-memory `Map` (`src/keystore/index.ts`), no
   longer in `sessionStorage` — so it's not readable via a storage API and is
   gone on page reload (re-unlock required). Residual: against an *active*
   in-origin XSS it's still reachable (the attacker can call the keystore's own
   decrypt API); a Web-Worker realm would add marginal defense at large cost.
3. **Web-client bootstrap** (§2): the server can ship malicious JS; the SW
   can't fully escape this.
4. **Message-length padding (done M7):** payloads are padded to fixed buckets
   before encryption (`src/lib/chatPayload.ts`), so ciphertext size reveals only
   the bucket, not the exact length. Residual: R2 media *blob* size still leaks
   separately.
5. **Header encryption (done M7):** the Double Ratchet header (DH pubkey, PN, N)
   is AEAD-encrypted under a per-chain header key (Signal's HE variant,
   `src/crypto/doubleRatchet.ts`), so it's opaque on the wire.
6. **Key-change detection is one-directional** (M3): it fires when the party
   who reset messages first; the reverse ordering isn't detected until a
   re-handshake. Fix = Signal-style session-reset signaling.
7. **Group PCS is weaker than 1:1**: sender keys give forward secrecy but heal
   only on rekey/membership change, not per-message like the Double Ratchet.
   Removal secrecy is *eventual* (a remaining member offline at removal keeps
   delivering to the removed member until it reconnects and rotates).
8. **Creator-relay trust** (M5 v1): sender-key distribution routes through the
   group creator; full-mesh + X3DH glare tie-breaking is deferred. The creator
   can't be removed.
9. **Session model**: sessions are 14-day sliding, with server-side revocation
   via a per-user `token_epoch` (checked every request). "Sign out everywhere"
   bumps the epoch and kills every outstanding token; a password change or
   account deletion does the same. Residual: single-device "Sign out" clears
   only this device's cookie (use "Sign out everywhere" after a suspected
   compromise).
10. **Signup abuse throttling is per-username, not per-actor**: we deliberately
    do not log IPs (invariant #5), so cross-username account-creation spam is
    not throttled server-side. Login brute-force *is* throttled per-username
    (residual: a temporary ~5-min login lockout DoS against a known username).
11. **Push relies on third-party push services** (FCM/Mozilla/Apple/WNS): the
    wake-up is content-free, but enabling notifications reveals to that service
    that a subscription exists (endpoint allowlisted, SSRF-guarded).
12. **Reproducible-build verification is not yet end-to-end** (§2).
13. **A sealed send is unconfirmed and can silently drop** (sealed sender,
    increment 5): the OHTTP gateway returns a uniform 202 for every sealed POST
    (non-oracle by design), so the sender can't distinguish delivery from a
    stale-token rejection at the recipient's DO, and there's no fallback or
    delivered-receipt for sealed messages yet. A message sent on a stale peer
    token (recipient rotated past the 3-slot grace) vanishes while the sender's
    view shows "sent." Increment 6's sealed delivered-receipt is the load-bearing
    fix; until then sealed sends are best-effort-unconfirmed.
14. **One-time-prekey exhaustion is accepted, and a last-resort prekey is
    deliberately NOT implemented.** An authenticated user can drain another
    user's one-time-prekey pool (`worker/keys.ts` `handleGetBundle`, throttled to
    one claim per requester/target/hour), forcing subsequent handshakes to fall
    back to no-OTP X3DH. We accept this, for two reasons that compound:
    - *No-OTP X3DH is already the normal case, not a degraded one.* The client
      tries the anonymous sealed lookup first (`src/lib/messaging.ts`
      `lookupBundle`), and that path cannot return a one-time prekey at all —
      `lookupBundleForSeal` hardcodes `oneTimePreKey: null`, precisely so an
      unauthenticated caller can't drain a pool. So the attack's payoff is to
      drag the rare authenticated-fallback path down to where the default path
      already sits.
    - *A last-resort prekey would not restore what's lost.* The one-time
      prekey's distinctive value is its one-time-ness: DH4 against a private key
      that is deleted after use, giving first-message break-in recovery. A
      last-resort key is reused by definition and discards exactly that
      property, leaving it largely redundant with the signed prekey already
      mixed into DH1/DH3. It would add a D1 migration, a worker path and client
      handling to buy close to nothing.
    **This residual depends on an invariant**: the anonymous lookup must stay
    *first*. If `lookupBundle` is ever reordered to prefer the authenticated
    fetch, an OTP is consumed on every first contact, the server learns who is
    about to be contacted, and the reasoning above becomes false. Pinned by
    `test-ui/bundleLookupPrivacy.test.ts`, which fails on that reordering.
15. **Username enumeration is intentional and unavoidable given contact-by-
    username.** Signup answers 409 for a taken name (`worker/index.ts`), and the
    *authenticated* bundle endpoint distinguishes 404 (no such user) from 409
    (exists, hasn't published keys) (`worker/keys.ts`). Both leak existence. You
    cannot let people add each other by username and simultaneously hide which
    usernames exist. Note the sealed path deliberately does *not* leak this: it
    returns a length-uniform "not found" sentinel that collapses both cases, so
    the anonymous lookup is a non-oracle.
16. **Media `DELETE` is authenticated but not authorized.** `handleMediaDelete`
    (`worker/media.ts`) deletes by object id with no ownership check, so any
    logged-in user who *knows* an id can delete that object. It is gated on the
    id being unguessable (random, only ever transmitted inside E2EE payloads to
    conversation participants) rather than on an ownership record. The blast
    radius is bounded: deletion only, no read; objects are already deleted on
    fetch-ack; the ciphertext is undecryptable to anyone outside the
    conversation. Worst case is denial of an undelivered attachment by someone
    already in the conversation. Accepted, but it is a capability check standing
    in for an access check, which is worth revisiting if media lifetimes ever
    lengthen.
17. **Account deletion leaves orphaned R2 media**, bounded by the 14-day bucket
    TTL rather than by the deletion itself. This is not an oversight: the server
    keeps no user→media mapping (invariant #5), so it *cannot* enumerate a
    departing user's objects, and building the index that would let it undercuts
    metadata minimization. Fully worked through under **invariant #6** in §5,
    including why we chose metadata-minimization over deletion-completeness.
    Listed here so the residual is findable from this list too.
18. **App-level TLS pinning of the native transport is not feasible for the JS
    channel, and is deliberately not done.** The iOS app is a WKWebView loading a
    bundled shell from `capacitor://localhost`; all server traffic is JS `fetch`
    and `WebSocket`, which WKWebView routes through the OS with standard CA
    validation and App Transport Security (TLS 1.2+, valid chain) — but gives the
    app no supported hook to pin (WKWebView's cert-challenge delegate covers
    top-level navigations, not JS `fetch`/`WebSocket`, and the shell never
    navigates to the origin at all). Routing `/api` through a native HTTP plugin
    (CapacitorHttp + a pinning delegate) could pin that leg, but the WebSocket —
    which carries the same session bearer token as its `flatfold.bearer.<token>`
    subprotocol — stays unpinnable short of a native WS rewrite, so partial
    pinning would guard only the login password while leaving the token exposed
    to the very CA-level MITM it claims to stop. That is the SRI tradeoff again
    (§2): a real-looking control that does not close the threat, while adding a
    hard cert-rotation outage risk (the shell is signed and not remotely
    updatable, so a broken pin needs an App Store cycle to recover). The
    transport therefore relies on OS TLS + ATS + CA validation. Message content
    is E2E-encrypted regardless of transport, so this affects only the bearer
    token, login password, and metadata against an active mis-issued-CA
    adversary — a threat outside §3's current adversary set.
19. **Opt-in account recovery stores an opaque, code-encrypted blob server-side
    (D7 §3).** When — and only when — a user turns on a recovery code, four
    nullable `users` columns are populated (`recovery_verifier`, `recovery_blob`,
    `recovery_salt_rec`, `recovery_salt_auth`; migration 0008, enumerated on
    `/transparency`). This is a deliberate, disclosed weakening of "no key backup"
    (invariant #3), scoped so it does **not** break "the server holds no
    decryption key":
    - `recovery_blob` is the user's **identity keys + contacts**, AEAD-encrypted
      client-side under `K_rec = Argon2id(recoveryCode, salt_rec)`. The server
      never sees the code or `K_rec`, so the blob is ciphertext it cannot decrypt.
      It carries a *snapshot* taken at enrollment (the code is never retained, so
      the blob can't be re-keyed later) and **never any message history** — that
      only ever lived in the device's IndexedDB and is unrecoverable on a fresh
      install, by design.
    - `recovery_verifier` is `hashPassword(recAuth)` where
      `recAuth = Argon2id(recoveryCode, salt_auth)` — a **separate** salt, so the
      value the server checks to authenticate a recovery request is provably not
      the key that unwraps the blob. The reset endpoint is rate-limited per
      username and bumps `token_epoch`; enrollment is password-reauthed so a
      hijacked session alone can't plant a recovery backdoor.
    - **Residual:** the blob's confidentiality rests entirely on the entropy of
      the recovery code against an offline attack on a seized blob (128-bit BIP39,
      stretched by Argon2id). A user who records a weak/guessable code, or whose
      written-down code is captured, loses that margin. This is the same
      password-strength dependence as the at-rest keystore key, now also exposed
      to a server-side-blob-theft attacker for opted-in users — the disclosed cost
      of making forgotten-password recovery possible at all.
20. **Opt-in TOTP two-factor adds three server-stored fields, all scoped (D7 §4).**
    When a user enables 2FA, migration 0009 populates `totp_secret`,
    `backup_code_hashes`, `totp_last_step` (enumerated on `/transparency`).
    - `totp_secret` is the RFC 6238 shared secret **AES-GCM encrypted at rest**
      under a key HKDF-derived from `SESSION_SECRET` (worker/totp.ts), so a D1 read
      alone can't recover it and downgrade the user to single-factor.
      **Rotation caveat (also in migrations/0009):** because that key comes from
      `SESSION_SECRET`, rotating the secret makes every stored `totp_secret`
      undecryptable — 2FA users then rely on their backup codes (hashed
      independently, so unaffected) or re-enroll. Anyone rotating `SESSION_SECRET`
      must know this.
    - `backup_code_hashes` are salted SHA-256 (`SHA-256(username‖code)`), never the
      codes; each is erased on use (single-use). A fast hash is sound only because
      each code is ≥64-bit CSPRNG — an invariant pinned by `test-ui/totp.test.ts`.
    - `totp_last_step` is a replay high-water mark (RFC 6238 §5.2). **Accepted
      papercut:** a second concurrent login within the same 30-second step is
      rejected (tested); backup codes bypass this counter.
    - **Deliberate v1 scope:** the forgot-password recovery path (#19) is NOT
      additionally gated by 2FA. The recovery code is itself a high-entropy
      ownership proof, and 2FA-gating recovery would risk locking out a user who
      still holds their recovery code but has lost their authenticator. Layering
      2FA onto recovery as defense-in-depth is a possible future hardening, not a
      closed hole today.
21. **Opt-in biometric unlock stores MK in a Secure-Enclave-gated Keychain item
    (D7 §5, native).** Enabling Face ID / Touch ID unlock writes the keystore
    master key to the iOS Keychain via a custom native plugin
    (`ios/App/App/FlatFoldBiometricPlugin.swift`) under an access-control object
    created with `.biometryCurrentSet` and `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`,
    read only through an `LAContext` authenticated with
    `.deviceOwnerAuthenticationWithBiometrics`. Consequences, by design:
    - The OS — not app JS — enforces the gate. MK is released ONLY on a live
      biometric match; **not** by device-unlock alone, and **not** by the device
      passcode (no passcode fallback on the item). This is why FlatFold ships a
      custom plugin instead of an off-the-shelf verify-then-retrieve one, which
      would leave MK retrievable from the Keychain without a live match — a
      password-independent at-rest path that would contradict Invariant 3.
    - `.biometryCurrentSet` invalidates the item if the enrolled biometrics change
      (a face/finger added or removed), so a coerced enrollment change destroys
      the stored key rather than exposing it. The user re-enables from Settings.
    - The password and recovery code remain the ultimate secrets; biometric is an
      on-device convenience wrapper that **never leaves the device** and is
      deleted on disable, on `.biometryCurrentSet` invalidation, or when the
      stored MK no longer opens the record. **Residual:** it inherits the device's
      biometric strength (e.g. Face ID's ~1e-6 false-accept, a compelled unlock),
      which is why it's opt-in and password-backed.

---

## 5. Self-review against the seven invariants

Format per invariant: **quote → enforcing code → test/evidence → residual**.

### Invariant 1 — "Plaintext never leaves the device."

- **Enforcing code:** all encryption/decryption is client-side —
  `src/crypto/` (X3DH, Double Ratchet, sender keys) driven by
  `src/lib/messaging.ts`. The wire frames carry base64 `ciphertext` only
  (`shared/types.ts` `WsSendFrame`/`WsGroupSendFrame`); the server
  (`worker/mailbox.ts`) relays opaque bytes. Media is encrypted before upload
  (`src/lib/media.ts`); R2 sees ciphertext.
- **Evidence:** crypto unit tests; systematic grep of `console.*` in `src/` +
  `worker/` — three `console.error` calls, none log message content (decrypt
  failures log a generic string, and by definition have no plaintext).
- **Residual:** payloads are length-padded to buckets (M7); the only remaining
  size signal is the R2 media blob length (#4 above).

### Invariant 2 — "The server stores no delivered messages."

- **Enforcing code:** `worker/mailbox.ts` — `handleDeliver` sends live and
  **never persists** when a socket is open; only offline envelopes are queued;
  `handleAck` deletes on the recipient's ack; `alarm()` hard-deletes at the
  14-day TTL regardless.
- **Evidence:** `test/mailbox.test.ts` — ack-gated deletion and TTL-sweep
  tests.
- **Residual:** none material; offline ciphertext is queued by design and
  bounded by ack + TTL.

### Invariant 3 — "Private keys never leave the device."

- **Enforcing code:** `src/keystore/` — identity keys and ratchet state live
  in IndexedDB, encrypted at rest with an Argon2id-derived key
  (`src/keystore/crypto.ts` `deriveKeystoreKey`, separately salted from the
  auth hash). Only *public* keys are published (`worker/keys.ts`). No escrow;
  no key backup **except** the opt-in, code-encrypted recovery blob (#19 in §4)
  — ciphertext the server can't read, present only if the user enables recovery.
- **Evidence:** the publish path sends only public key material; Playwright
  verifies the keystore-unlock gate is a separate step from server login.
- **Residual:** the in-memory keystore key is reachable by an active in-origin
  XSS via the keystore's own API (#2 in §4) — no longer in `sessionStorage` (M7).
  Opt-in recovery backs up the identity keys as an opaque code-encrypted blob
  (#19 in §4) — a disclosed, scoped exception to "no key backup," never readable
  by the server.

### Invariant 4 — "Forward secrecy and post-compromise security."

- **Enforcing code:** `src/crypto/doubleRatchet.ts` — DH ratchet (PCS) +
  symmetric-key ratchet (forward secrecy), with a bounded skipped-key cache
  for out-of-order/dropped messages. Groups: `src/crypto/senderKey.ts` (a
  one-way hash ratchet → forward secrecy).
- **Evidence:** RFC/spec vectors + property tests in the double-ratchet
  suite; `src/crypto/senderKey.test.ts` proves a late joiner can't read
  earlier messages and a retained key can't decrypt post-rotation.
- **Residual:** group PCS is weaker than 1:1 (#7 in §4). (Header encryption is
  now implemented — #5 — so the ratchet header is no longer server-visible.)

### Invariant 5 — "Metadata minimization."

- **Enforcing code:** contact lists live only in the encrypted keystore
  (never sent to the server); no code logs IPs anywhere; stored envelope
  timestamps are coarsened to the minute (`worker/mailbox.ts` `handleSend`);
  registration time is minute-coarsened (`worker/index.ts` `handleSignup`);
  read receipts / typing indicators are not persisted (not implemented; would
  travel in-channel if added).
- **Evidence:** grep confirms no IP access/logging anywhere in `worker/` or
  `src/`; envelope `ts` is floored to the minute.
- **Residual — significant:** the **communication graph and timing are
  visible** via DO-to-DO routing (§1). Also: the *application* logs no IPs,
  but Cloudflare's edge sees connection IPs at the platform layer (§1) —
  "no IP logging" is an app-level statement, not a claim that IPs are
  invisible to the infrastructure. Invariant #5's letter (no server-side
  plaintext *contact lists*) is met; its spirit (hide who talks to whom) is
  **not** — no sealed sender. Push endpoints are also stored per user.

### Invariant 6 — "Deleting an account deletes everything, synchronously."

- **Enforcing code:** `worker/account.ts` `handleDeleteAccount` (requires
  password re-auth, not just a session) → `worker/mailbox.ts` `handlePurge`
  (`storage.deleteAll()` + cancels the TTL alarm + closes the socket) and
  `worker/db.ts` `deleteUserData` (atomic D1 batch: `users`,
  `one_time_prekeys`, `push_subscriptions`, `rate_limits`). The client then
  wipes its local keystore (`src/lib/panicWipe.ts`). No soft-delete.
- **Evidence:** `test/account.test.ts` — create → seed rows + DO storage →
  delete → asserts every D1 row gone, DO storage empty, re-login fails;
  separate tests prove password re-auth is required and unauthenticated
  deletion is rejected.
- **Residual (by design, noted for honesty):**
  - Ciphertext this user *sent* that sits queued in *other* users' mailboxes
    is not deleted — it is ciphertext addressed to those recipients (their
    data, not this user's), and deleting it would silently break their
    delivery. It clears on their ack or the 14-day TTL.
  - **R2 media the user uploaded is not deleted on account close.**
    `worker/media.ts` `handleMediaUpload` stores each attachment under a
    random id with **no server-side user→media mapping** — deliberately, so
    the server never learns whose media is whose (invariant #5). The direct
    consequence is that the server *cannot* enumerate a departing user's R2
    objects to delete them. Building an index to enable that deletion would
    undercut #5, so the honest tradeoff is: uploaded media is unreadable
    ciphertext (the key never left the sender's E2EE payload) bounded by
    fetch-ack deletion and the deploy-time 14-day R2 TTL, not by account
    deletion. We chose metadata-minimization over deletion-completeness here
    and say so.

### Invariant 7 — "No third-party trackers, fonts from own origin, no CDN scripts."

- **Enforcing code:** all fonts are self-hosted (`public/fonts/*.woff2`); no
  analytics/tracker code exists; the CSP (`connect-src 'self'`,
  `script-src 'self'`, `default-src 'none'`) structurally blocks
  cross-origin scripts and beacons; all dependencies are bundled by Vite (no
  runtime CDN fetches).
- **Evidence:** CSP enforced in the production build; no external origins in
  the client.
- **Residual:** content-free push goes to a third-party push service the user
  explicitly opts into (§4 #11) — not a tracker, but a third party; disclosed
  on the transparency page.

---

## Verdict

Five of the seven invariants are enforced end-to-end with tests pointing at
the code. **Invariant 5 is met in letter but not spirit** — the communication
graph is exposed — and this is called out prominently rather than hidden
behind a checkmark. Invariant 1 now includes length padding (only the R2 media
blob size still leaks). A follow-up M7 hardening pass added message-length
padding, Double Ratchet header encryption, and moved the keystore key out of
`sessionStorage` — closing the padding/header/at-rest-key residuals. The
largest remaining residual risks are the metadata graph (§1) and the
web-client bootstrap (§2), both structural to a serverless web messenger and
both disclosed to users on `/transparency`. Sealed sender is being built
**incrementally** (see `docs/SEALED_SENDER.md`) and is now **partially active**:
as of increment 5, messages on an **established session** where the sender holds
the recipient's delivery token are sent sender-hidden (from-less, HPKE-gateway),
so the server no longer sees the sender for those. **What is NOT yet hidden**, so
the social-graph residual (§1) is *reduced, not closed*: (a) first-contact
messages still use the normal server-attested path (sealing them safely needs
bundle-key verification — a follow-up); (b) a send with no known peer token, or
one where the sealed POST fails synchronously, **falls back to a sender-revealing
WS send**; and (c) the benefit is anyway capped, on this web architecture, by the
concurrent
authenticated receive socket + edge-IP correlation. **The non-colluding third-party relay now exists** — sealed sends
traverse an OHTTP relay operated by an independent organization (Oblivious Network
LLC), so the gateway no longer sees the sender's IP either; the relay sees the IP
but not the content, and it takes both parties colluding to rejoin them.
First-contact is also now sealed (increment 7). What remains uncapped is the
receive transport: the authenticated WebSocket still exposes the online set + IPs,
so presence-intersection re-links senders statistically over time. Net: for
ongoing conversations the sender (identity **and** IP) is hidden from the
application server, trivial→statistical; the residual is the receive-side presence
leak, not the send path.

Landed so far: the OHTTP gateway (`worker/seal.ts`) and the **delivery-token**
layer (increment 2) — each account publishes a random token that a future
sealed send will present to the recipient's mailbox. **Be precise about what
the token is and isn't:** it rides the (public, first-contact-fetchable) prekey
bundle, so it is *not* a secret capability. Its value is anti-spam /
per-recipient rate-limit hygiene and cutting off a **passive** removed contact
after rotation — **not** cryptographic access control. A determined removed
contact can re-fetch the bundle for the fresh token, or simply send unsealed.
The token set the recipient's DO validates is the authoritative one; the D1
bundle copy is a convenience for first-contacters. No message is sealed
end-to-end yet — that arrives with the client sealed-send + receive rework.

Increment 3 adds the **anonymous bundle-fetch mechanism**: the gateway will let
a first-contact initiator fetch a peer's bundle (+ token) without the server
learning who asked (HPKE-encapsulated request, no session cookie; the response is
sealed with the RFC 9458 §4.4 exporter-secret AEAD, since `@hpke/core` can't seal
on the context). It is **built but not yet wired into the live flow** (that lands
in increment 4, paired with the sealed send — flipping it alone gives no privacy
while the send still names the sender). The gateway learns the lookup *target*,
never the initiator. Three residuals it introduces, honestly (they bite at the
increment-4 flip):
- **Anonymous enumeration.** The `op:'fetchBundle'` branch is an unauthenticated
  username-existence oracle: anyone with the gateway public key (i.e. everyone)
  can probe it, and unlike the authenticated bundle path (30/60s per requester)
  there's no authenticated requester to key a per-actor limit on. As
  defense-in-depth before a relay exists, the gateway applies a **blunt global
  fixed-window throttle** (`ANON_FETCH_GLOBAL_LIMIT`, currently 120/60s, in
  `worker/seal.ts`) across *all* anonymous fetches. This caps enumeration speed,
  but being global it is itself a **DoS lever** — a flood can throttle legitimate
  first-contacts app-wide — and it's coarse; the real per-actor throttle belongs
  at the (deferred, external) OHTTP relay's allow-list. Over the cap the gateway
  returns a uniform empty 202 (not a per-target signal — the limit is global, so
  it never leaks whether a given username exists), and the sealed "not found" is
  length-uniform, so this is not a *content* oracle to a relay — but the gateway
  operator remains directly probeable up to the global rate. Independent of client
  wiring (the endpoint is live regardless of whether `ensureSession` uses it).
- **First-message forward secrecy.** The anonymous path deliberately does not
  consume a one-time prekey (an unauthenticated caller could otherwise drain a
  victim's pool), so sealed first-contacts use a signed-prekey-only X3DH — Signal-
  class but weaker first-message FS than an OTP session. Once increment 4 makes
  sealed fetch the default, one-time prekeys go largely unconsumed.
- **Response-size metadata.** A sealed *send* returns an empty 202 while a sealed
  *fetchBundle* returns a sealed body, so response size lets a relay/network
  observer distinguish "new-contact lookup" from "ongoing send" (neither reveals
  who). Uniformizing the two is a follow-up.
