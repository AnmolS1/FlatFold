-- D7 §4: opt-in TOTP two-factor. Three nullable columns on `users`
-- (all NULL = 2FA not enabled).
--
-- totp_secret: the RFC 6238 shared secret, AES-GCM encrypted at rest under a key
-- HKDF-derived from SESSION_SECRET (worker/totp.ts). Encrypting it means a D1 read
-- alone can't downgrade a 2FA user to single-factor.
--   ⚠️ ROTATION CAVEAT: because the at-rest key comes from SESSION_SECRET,
--   rotating SESSION_SECRET makes every stored totp_secret undecryptable. 2FA
--   users then fall back to their backup codes (hashed independently, so still
--   valid) or re-enroll. Rotating SESSION_SECRET already invalidates all sessions;
--   this adds "and strands TOTP secrets." Documented in docs/THREAT_MODEL.md.
--
-- backup_code_hashes: a JSON array of salted SHA-256 hashes (SHA-256(username||
-- code)); each is removed from the array when used (single-use). Safe as a fast
-- hash because each code is ≥64-bit CSPRNG (pinned in src/lib/totp.ts).
--
-- totp_last_step: the highest TOTP time-step already accepted, a replay
-- high-water mark (RFC 6238 §5.2 single-use). NULL until the first 2FA login.
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN backup_code_hashes TEXT;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
