# D7 — account features: 2FA, change password, delete account, and the forgot-password problem

The redesign adds account controls and an optional second factor. Most are easy; one (forgot password) is a genuine cryptographic problem in an app like this, and the naive version is exactly the security hole Anmol flagged. This doc works it out. **This is security-critical protocol work** — it touches the keystore and the worker, so it must be built with the same rigor as the rest of the crypto (test vectors, property tests, review), not folded casually into UI work.

## 0. Why 2FA is a login layer, not a recovery method (read this first)

The password does **double duty** (see below): server login *and* deriving the local keystore key. 2FA (TOTP) is a factor the **server verifies** — it fits the login half perfectly and is a real security win, so we add it. But it cannot be the *recovery* method: a TOTP code proves identity to the server, and the server never held your keystore key, so it can't give it back. "Recovering" via 2FA alone would restore your login while your identity keys, history, and verified status stay locked behind the forgotten password — silent data loss dressed up as recovery. And you can't wrap the keys under the TOTP seed, because the server shares that seed (it needs it to verify codes), so that would let the server decrypt your keys — the one thing FlatFold won't do. **Conclusion: add 2FA for login (§4); keep the recovery code for recovery (§3).** They solve different problems.

## The setup that makes this hard

In FlatFold the password does **double duty**:
1. **Server login** — the server stores an Argon2id *verifier* of the password.
2. **Local keystore** — the same password derives (Argon2id, separate salt, client-side) the key that encrypts the IndexedDB keystore, which holds the identity keys, sessions, and message history.

There is **no email or phone** (username-only). So there is no out-of-band channel to prove "it's really me."

## 1. Change password — easy, safe (requires the current password)

Flow: user enters current + new password.
- Client re-encrypts the local keystore: decrypt with the current-password-derived key (this also proves they know the current password), re-encrypt under the new-password-derived key (fresh salt).
- Server: `POST /api/auth/change-password {current, new}` — verifies `current` against the stored verifier, stores the new verifier, bumps `token_epoch` (kills other sessions), returns a fresh token.
- Ordering/atomicity: the server verifier and the local keystore key are independent (different salts), so both must change together or the user ends up able to log in but not unlock (or vice-versa). Re-encrypt the keystore in memory first, call the server, and only commit the re-encrypted keystore on server success; roll back on failure. Persist a "password-change pending" marker so a mid-flight crash can be recovered, not left split.
- **Not an "anyone resets anyone" risk** — it requires the current password.

## 2. Delete account — already exists, just wire the entry point

The server side exists (password-reauthed `DELETE /api/account`, wipes D1 + the mailbox DO). The native Settings "Delete account" (danger zone) calls it and then runs the local panic-wipe. No new backend.

## 3. Forgot password — the real problem, and the fix

**Why the naive version is broken (Anmol's worry, confirmed):** a "reset by username" endpoint with no proof of ownership lets anyone take over any account. And even if you authenticated it, the identity keys + history are encrypted with the *old* password-derived key — unrecoverable — so a bare reset silently destroys the account's history and its verified status with contacts (they'd see a key change). With no email/phone, there is no built-in channel to prove identity.

**The only secure, honest answer is a user-held recovery secret established in advance.** Design:

### Recovery code (opt-in; offered at signup and in Settings)
- The client generates a high-entropy **recovery code** (a ~128-bit value shown as a word list or long base32 string — enough to resist offline brute force, because it ultimately gates the keystore).
- From it, derive (Argon2id, own salt) a **recovery key**. Then create:
  - **(a) a recovery-wrapped keystore key** — the keystore's master key, encrypted under the recovery key (an opaque blob the server can't read).
  - **(b) a recovery verifier** — an Argon2id hash of the recovery code, stored server-side next to the password verifier, so the server can authenticate a recovery request *before* allowing a new password. This is what makes reset require proof of ownership, not just a username — closing the takeover hole.

### Forgot-password flow
1. User taps "Forgot password" and enters their recovery code.
2. Server checks the code against the recovery verifier (**rate-limited per username**, like login).
3. Client derives the recovery key, fetches the recovery-wrapped keystore key, and unwraps it → the identity keys + history are back.
4. User sets a new password; client re-wraps the keystore key under the new-password key; server stores the new password verifier and bumps `token_epoch`.
5. Result: same account, same keys, same history, same verified status — recovered without the server ever seeing the code, the recovery key, or the keystore key.

### If there's no recovery code and the password is lost
Be honest, and say it **before** it can happen (at signup and wherever the code is offered): without the recovery code, the account and its history cannot be recovered — by design, because the alternative is a server that can hand out account access, which is the whole thing FlatFold refuses to be. The only path then is starting a new account. This candor is itself the "up-front" quality Anmol wants; don't paper over it with a false "reset" button.

### Where the recovery blob lives — DECIDED: server-stored (opaque)
Anmol confirmed **server-stored**. The recovery-wrapped keystore key is uploaded as an opaque blob the server can't read, so forgot-password works on a new device or after a reinstall (when people actually forget passwords). It stays zero-knowledge, but it adds **one opaque encrypted blob per opted-in user** to the server's footprint, which must be disclosed on `/transparency`, in `THREAT_MODEL.md`, and in the App Privacy label. 2FA (§4), when enabled, additionally gates the recovery-blob fetch as defense in depth — but the recovery code, not the 2FA code, is what unwraps it.

### Security properties to build and test
- Server never sees: the recovery code, the recovery key, or the keystore master key. Only the opaque recovery verifier (and, if chosen, the opaque wrapped blob).
- Every credential change (change *or* reset) bumps `token_epoch`.
- Recovery-verify endpoint is rate-limited per username; the code's entropy resists offline attack on a seized blob.
- New crypto + a D1 migration (recovery verifier, optional blob) + keystore changes — treat as crypto-critical: spec test vectors, property tests (wrap/unwrap round-trip, wrong-code failure, tamper failure), and a self-review, same discipline as the ratchet code. Update `/transparency`, `THREAT_MODEL.md`, and the App Privacy label to reflect the new stored fields and the recovery model.

## 4. Two-factor authentication (TOTP) for login + biometric unlock

**Standard TOTP (RFC 6238), not a vendor.** Implement time-based one-time codes that work with any authenticator (Google Authenticator, Authy, 1Password) — do not integrate a specific product like Cisco Duo; that's a third-party dependency against the app's ethos and adds a vendor. Optional, opt-in per account.

- **Enable:** in Settings, the client shows a QR (the `otpauth://` URI) + the secret; the user adds it to their authenticator and confirms one code to turn it on. The server stores the TOTP shared secret (encrypted at rest) — a new stored field, disclose it on `/transparency` and the privacy label. Generate one-time backup codes at enable time (also stored as hashes server-side) so a lost authenticator doesn't lock the user out of *login*.
- **On login:** after the password check, if 2FA is on, require a valid TOTP code (rate-limited). Only then issue the session token. This is the "require the code to log in" behavior.
- **Stay logged in per device:** 2FA gates *establishing* a session, not every request. The existing long, sliding, `token_epoch`-revocable session (L3) means login is infrequent, so a trusted device rarely re-prompts. Optionally offer "trust this device for 30 days" to skip 2FA on re-login from the same device (a device token; keep it optional).
- **Biometric keystore unlock (native):** separately from server login, wrap the keystore key with a Secure Enclave / Android Keystore key gated by Face ID / Touch ID, so day-to-day the user unlocks with biometrics instead of retyping the password. The password and recovery code remain the ultimate secrets; biometrics is an on-device convenience wrapper, never sent anywhere. This is the native expression of "stay logged in."
- **Interaction with recovery:** if 2FA is on, it also gates the recovery-blob fetch (defense in depth). It does not replace the recovery code — see §0.
- **Build carefully:** TOTP verification (constant-time), secret + backup-code storage (encrypted/hashed at rest), rate limiting, and the biometric wrap are security-critical; test them (valid/invalid/expired codes, replay within the window, backup-code single-use).

## Also worth adding for "up-front" (low cost, high trust signal)
- An **About** row in Settings: app version + build, a "View source" link (it's AGPL/open source — show it), links to the in-app transparency page, the threat model, and the security contact (`security@flatfold.ponderance.dev`).
- Onboarding that explains the **two-lock model** (server login vs. the local keystore unlock) plainly, and the recovery-code choice with its honest warning, so nothing about the security model is a surprise.

## User-facing copy (drafted in Anmol's voice — use verbatim or run through write-like-anmol if you edit)

Recovery-code setup:
- Title: "Your recovery code"
- Body: "If you ever forget your password, this code is what gets your account and your messages back."
- Warning: "Keep it somewhere safe and private. If you lose both your password and this code, no one can get the account back, not even me. That's the point."
- Confirm: "I've saved my recovery code"

Forgot password:
- Title: "Enter your recovery code"
- Body: "This is the only way back into your account. Enter the recovery code you saved when you turned this on."
- No-code case: "No recovery code? Then there's no way back into this one, by design. You can start fresh with a new account."

Two-factor setup:
- Title: "Turn on two-factor"
- Body: "Add a second lock to signing in. Scan this with your authenticator app, then enter a code to confirm."
- Honest note: "Two-factor protects who can sign in. It doesn't unlock your messages on its own, so keep your recovery code too."
- Backup codes: "Save these backup codes somewhere safe. Each one works once, for when you don't have your authenticator."

Two-lock onboarding:
- "FlatFold has two locks. One signs you in to the service. The other unlocks your messages on this device, and only you hold the key to that one."
