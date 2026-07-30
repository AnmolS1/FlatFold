# D7 implementation plan — account features + 2FA + recovery

Status: **proposal for review**. No crypto is written until this is signed off.
This is the one sanctioned exception to the crypto/keystore/worker freeze, so it
gets the ratchet-grade treatment: spec test vectors, property tests, self-review.

Grounded in the current code (see the touchpoint map). The decisive fact:

> **There is no keystore master key today.** `deriveKeystoreKey(password, salt)`
> (Argon2id) produces a key that **directly** encrypts every IndexedDB blob
> (identity, sessions, messages, contacts, groups, media). Change-password and
> recovery both hinge on fixing this.

---

## 0. Foundational change — introduce a keystore master key (MK)

Everything else depends on this, so it lands first, on its own, fully tested.

**Why.** With the password-derived key encrypting everything directly:
- *Change-password* would have to re-encrypt **every store** under a new key
  (a loop over all IndexedDB records) — slow, and non-atomic (a crash mid-loop
  leaves a half-re-encrypted store).
- *Recovery* is impossible: the key is a pure function of the password, so a
  forgotten password = unrecoverable local data (today's "recovery" silently
  generates a **fresh** identity — `AuthContext.establishLocalIdentity`).

**The fix.** A random 32-byte **master key (MK)** encrypts all the stores. MK is
then *wrapped* (small, cheap) under each credential that should unlock it:
- `wrap_password = AEAD(K_pw, MK)` where `K_pw = Argon2id(password, salt_pw)`
- `wrap_recovery = AEAD(K_rec, MK)` where `K_rec = Argon2id(recoveryCode, salt_rec)` (opt-in)
- `wrap_biometric = AEAD(K_bio, MK)` where `K_bio` is a Secure-Enclave key (native, opt-in)

Now: **unlock** = derive `K_pw`, unwrap MK, cache MK, use MK for all stores.
**Change-password / recovery / biometric** only re-wrap the 32-byte MK — no
bulk re-encryption, and each is a single atomic record write.

**IdentityRecord migration (v1 → v2).**
```
v1 (today):  { salt, blob }                       // blob encrypted under K_pw
v2 (new):    { version: 2, salt_pw, wrap_password, blob }   // blob encrypted under MK
```
- New accounts: generate MK at `createIdentity`, encrypt the doc under MK, store
  `wrap_password`.
- **Existing accounts**: on the next successful `unlock`, detect a v1 record,
  derive `K_pw`, decrypt the v1 doc, generate MK, re-encrypt the doc **and every
  other store** under MK, write the v2 record + re-wrapped stores in one pass,
  behind a `keystore-migration-pending` marker so a mid-flight crash re-runs it.
  This one-time per-user re-encryption is the only "encrypt everything" cost,
  and it happens while already unlocked with the correct password.

**Tests (Phase 0).**
- Round-trip: create v2 identity → lock → unlock → all stores readable.
- Migration: seed a v1 record + stores → unlock → v2 record present, MK-encrypted,
  all data intact; marker cleared. Interrupted-migration (marker set, partial) →
  re-run completes.
- Wrong password → `wrong-password` (AEAD tag mismatch on `wrap_password`, never
  touches MK).
- Property: `unwrap(wrap(MK)) == MK` for random MK/keys; tamper any byte of
  `wrap_password` → decrypt throws.

---

## 1. Change password (D7 §1)

**Client** (`keystore`): given current + new password —
1. `K_pw_old = Argon2id(current, salt_pw)`; unwrap MK (proves current password).
2. `salt_pw' = fresh`; `K_pw_new = Argon2id(new, salt_pw')`; `wrap_password' = AEAD(K_pw_new, MK)`.
3. Build the candidate v2 record in memory (don't commit yet).
4. Call the server (below). On **success**, commit the record (single write) +
   clear a `password-change-pending` marker. On failure, discard (MK/stores
   untouched — nothing was re-encrypted, only the wrap changed).

**Server** (`worker`): `POST /api/auth/change-password {current, new}` — mirror
`handleLogoutAll`: `verifyPassword(current, stored)`, `hashPassword(new)` →
`updatePassword(db, username, newVerifier)` (new `db.ts` helper), `bumpTokenEpoch`,
return a fresh token at the new epoch. Reject weak `new` (`isValidPassword`).

**Atomicity.** MK is unchanged, so the stores are never in a mixed state. The
only two mutations are (a) the server verifier + epoch and (b) the local
`wrap_password`. Order: re-wrap in memory → server call → commit local on 2xx.
A crash between them is caught by the pending marker (on next unlock: if the
server already advanced the epoch, the old token is dead → re-login with the new
password re-derives `K_pw_new`, which matches the committed-or-not wrap; if not
committed, the old wrap still works with the old password → user retries).

**Client API**: `apiChangePassword(current, new)` in `src/lib/api.ts` (copy
`apiLogoutAll`). **UI**: a form in Settings (current + new + confirm).

**Tests**: correct current → succeeds, new password unlocks, old fails, epoch
bumped (other sessions 401). Wrong current → server 401, local unchanged.
Server-fails-after-local-rewrap → rollback path leaves the old wrap working.

---

## 2. Delete account (D7 §2) — already wired

`SettingsDialog` → `apiDeleteAccount(password)` + local panic-wipe. Present.
Only add it to the D7 test sweep; no new code.

---

## 3. Recovery code / forgot-password (D7 §3) — server-stored opaque blob

**Enrollment** (opt-in, at signup and in Settings), while unlocked (MK in hand):
1. Generate a **recovery code**: 128 bits from `randomBytes(16)`, rendered as a
   word list (BIP39-style, decided below) or Crockford base32. Shown once.
2. `salt_rec = fresh`; `K_rec = Argon2id(code, salt_rec)`; `wrap_recovery = AEAD(K_rec, MK)`.
   ← the opaque recovery blob. Server can't read it (no code, no K_rec).
3. Recovery **authenticator** (separate derivation so the value sent to the
   server is NOT the wrapping key): `salt_auth = fresh`;
   `recAuth = Argon2id(code, salt_auth)`.
4. Upload `{ salt_rec, salt_auth, wrap_recovery, recAuth }`. Server stores
   `recovery_blob = wrap_recovery`, `recovery_salt_rec`, `recovery_salt_auth`,
   `recovery_verifier = hashPassword(recAuth)` (server-side Argon2id of the
   authenticator — so even the authenticator isn't stored in the clear).

> **Zero-knowledge preserved.** Server sees `recAuth` transiently (like it sees
> the password at login) and stores only a hash of it. It never sees the code or
> `K_rec`, so it can never unwrap MK from `recovery_blob`. The THREAT_MODEL claim
> "the server never holds a decryption key" stays true: the blob is ciphertext
> the server cannot decrypt.

**Forgot-password flow** (new device / reinstall — no local data):
1. Client asks the server for the public **salts** for `username`
   (`GET /api/auth/recovery/params` → `{ salt_rec, salt_auth }` or 404 if no
   recovery enrolled). Salts aren't secret.
2. User enters the code; client computes `recAuth = Argon2id(code, salt_auth)`;
   `POST /api/auth/recovery/verify {username, recAuth}` — **rate-limited per
   username** (reuse the `rate_limits` table / `login:` pattern). Server
   `verifyPassword(recAuth, recovery_verifier)`. If 2FA is on, this endpoint also
   requires a valid TOTP (defense in depth). On success returns a short-lived
   **recovery ticket** + `recovery_blob`.
3. Client derives `K_rec = Argon2id(code, salt_rec)`, unwraps MK from the blob →
   identity + history restored.
4. User sets a new password: `wrap_password' = AEAD(Argon2id(new, salt_pw'), MK)`;
   `POST /api/auth/recovery/reset {ticket, newVerifier}` → server stores the new
   password verifier, `bumpTokenEpoch`, issues a session token. Client writes the
   v2 record locally.

**No-code case**: honest copy (D7 verbatim) at enrollment and on the forgot
screen — no code + no password = unrecoverable, by design.

**Server changes**: migration `0008_recovery.sql` adds `recovery_verifier`,
`recovery_blob`, `recovery_salt_rec`, `recovery_salt_auth` (nullable) to `users`;
`worker/db.ts` `UserRow` + `setRecovery`/`getRecoveryParams`/`clearRecovery`
helpers; routes in `worker/index.ts`; **`src/data/serverState.ts` entries in the
same commit** (drift test).

**Tests**: enroll → wrap/unwrap round-trip restores MK; correct code on a fresh
store restores all data; **wrong code** → verify 401 + no blob released; tampered
blob → unwrap throws; rate-limit trips after N tries; reset bumps epoch; recovery
while 2FA-on requires the TOTP. Property: `unwrap(K_rec, wrap_recovery) == MK`.

---

## 4. TOTP 2FA (D7 §4) — standard RFC 6238, server-verified

**Missing primitives**: HMAC-SHA1 (only SHA-256 is wired in `primitives.ts`) and
base32 — both from `@noble/hashes` (already a dep); add a small `src/lib/totp.ts`
(client, for enrollment/QR) and server-side verification in `worker`.

**Enable** (Settings): client generates a 20-byte secret → base32 → `otpauth://`
URI → QR (reuse the `SafetyNumberDialog` SVG-QR renderer) + the secret text.
User confirms one code. `POST /api/auth/2fa/enable {secret, code, backupCodes[]}`:
server verifies `code` against `secret` (constant-time, ±1 step window), stores
`totp_secret` **encrypted at rest** (AEAD under a worker secret) and
`backup_code_hashes` (hashed, single-use). Generate 10 one-time backup codes
client-side, show once.

**Login**: `handleLogin` — after `verifyPassword`, if `totp_secret` present,
respond `401 {twoFactorRequired: true}` instead of a token; client prompts for
the code; `POST /api/auth/login` again with `{username, password, code}`
(rate-limited); server verifies TOTP **or** a backup code (mark it used), then
issues the token. 2FA gates *establishing* a session only (the sliding
`token_epoch` session means re-login is rare). Optional "trust this device 30
days" = a device token, deferred to a follow-up.

**Server**: migration `0009_totp.sql` (`totp_secret`, `backup_code_hashes`,
nullable); verification helper (WebCrypto `crypto.subtle` HMAC-SHA1 is available
in workerd). Constant-time compare. Rate-limit `2fa:${username}`.

**Tests** (vectors from RFC 6238 test values): valid code passes; expired/future
code fails; replay within the window rejected (track last-used step); backup code
works once then fails; wrong code rate-limits; enable requires a valid confirm.

---

## 5. Biometric keystore unlock (D7 §4, native)

Wrap MK under a Secure Enclave / Android Keystore key gated by Face ID / Touch
ID: `wrap_biometric = AEAD(K_bio, MK)` stored locally (Keychain, not the doc).
Day-to-day unlock returns MK without the password. The password + recovery code
remain the ultimate secrets; biometric is an on-device convenience, never sent
anywhere. Needs a Capacitor biometric plugin (evaluate `capacitor-native-biometric`
vs `@aparajita/capacitor-biometric`) + `NSFaceIDUsageDescription`. **Deferred to
the end of D7** (it rides on MK being in place; lowest crypto risk, highest
native-integration risk) and verified on the real device.

---

## 6. Disclosure (required, same commits as the server changes)

- `src/data/serverState.ts`: add `PersistedField`s for `totp_secret`,
  `backup_code_hashes`, `recovery_verifier`, `recovery_blob`, `recovery_salt_*`
  (CI drift test enforces this).
- `docs/THREAT_MODEL.md`: a subsection explaining each new stored field and why
  the opaque recovery blob does **not** violate "the server holds no decryption
  key" (it's ciphertext under a key derived from a secret the server never sees).
- App Privacy label (D6) + `/transparency` copy: the new fields, opt-in.
- Onboarding: the two-lock model + the recovery-code choice with the honest
  warning (D7 copy, verbatim).

---

## 7. Build order (each phase: TDD, green, self-review, then on-device)

1. **MK foundation + migration** (§0) — no user-facing change; unlock still works,
   existing accounts migrate transparently. Gate everything else on this.
2. **Change password** (§1) — Settings form.
3. **Recovery code** (§3) — enrollment (signup + Settings) → forgot-password flow.
4. **TOTP 2FA** (§4) — enable/verify/login/backup codes.
5. **Biometric unlock** (§5) — native, real-device.
6. **Disclosure** (§6) — folded into 1–5 as each field is added; final copy pass.

---

## Decisions — SIGNED OFF (2026-07-24)

1. ✅ **Introduce the keystore master key (MK) + migrate existing accounts on
   next unlock.** Approved.
2. ✅ **Recovery verifier = server-side Argon2id of a *separate* authenticator
   derived from the code.** Approved (not PAKE).
3. ✅ **Recovery code format = BIP39-style word list** (12 words / 128-bit,
   checksummed — catches transcription errors, easiest to write/re-type).
4. ✅ **TOTP verified server-side** (secret encrypted at rest).
5. ✅ **Backup codes: 10 single-use, hashed server-side.**
