-- D7 §3: opt-in account recovery. Four nullable columns on `users`
-- (NULL = the user has not enrolled a recovery code).
--
-- recovery_blob is the user's identity keys + contacts, encrypted client-side
-- under a key derived from a user-held recovery code — OPAQUE to the server, it
-- holds no key that can decrypt it. It exists so a user who forgets their
-- password can recover on a new device without the server ever being able to
-- hand out account access.
--
-- recovery_verifier is an Argon2id hash of a SEPARATE authenticator derived from
-- the code (its own salt), so the server can authenticate a recovery request
-- before releasing the blob — WITHOUT ever seeing a value that could unwrap it.
-- The two salts are public (needed to re-derive the keys on recovery).
ALTER TABLE users ADD COLUMN recovery_verifier TEXT;
ALTER TABLE users ADD COLUMN recovery_blob TEXT;
ALTER TABLE users ADD COLUMN recovery_salt_rec TEXT;
ALTER TABLE users ADD COLUMN recovery_salt_auth TEXT;
