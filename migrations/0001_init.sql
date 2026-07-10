-- weeboweebo persistent database — the ENTIRE server-side store.
-- Kept auditable in one file: if law enforcement shows up with a subpoena,
-- the honest and complete answer is exactly what is in this table and
-- nothing else. See docs/ARCHITECTURE.md and the (future) /transparency page.

CREATE TABLE IF NOT EXISTS users (
	username           TEXT PRIMARY KEY NOT NULL, -- exact-match handle, no email/phone
	password_verifier  TEXT NOT NULL,             -- Argon2id PHC-format hash (salt embedded)
	identity_pubkey    TEXT,                      -- nullable in M1 — X3DH identity key (M2)
	signed_prekey      TEXT,                      -- nullable in M1 — rotated signed prekey (M2)
	created_at         INTEGER NOT NULL           -- unix seconds, coarsened to the minute
);

-- one_time_prekeys is deliberately NOT created here. An empty, unused table
-- would not be "minimal and auditable" — it will be added in a later
-- migration (M2) once X3DH lands and it holds real data.
