-- L3: per-user session epoch for stateless-token revocation. The session token
-- carries the epoch it was issued under; a request is authenticated only if the
-- token's epoch still matches the user's current token_epoch. Bumping the epoch
-- ("Sign out everywhere", and future password changes) instantly invalidates
-- every token issued before the bump, without a server-side session table.
ALTER TABLE users ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0;
