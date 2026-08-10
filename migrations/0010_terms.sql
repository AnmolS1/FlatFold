-- App Review 1.2: every account must accept terms that state there is no
-- tolerance for objectionable content or abusive users, BEFORE the app is
-- usable. Two nullable columns on `users`.
--
-- terms_accepted_at: unix seconds, coarsened to the minute like `created_at`
-- (migrations/0001_init.sql) — the exact second says nothing useful and a
-- coarser timestamp is one less thing to correlate. NULL = not accepted, which
-- is deliberately the default for EVERY EXISTING ROW: the gate is retroactive,
-- so users who signed up before this migration are gated on their next sign-in
-- rather than grandfathered in. Apple checks that the agreement is universal.
--
-- terms_version: which revision was accepted. Written by the SERVER from a
-- constant (worker/terms.ts), never from the request body — a client-supplied
-- version would let a caller store a future string and skip the next re-gate.
-- Bumping the constant re-gates everyone, which is the point of storing it.
ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER;
ALTER TABLE users ADD COLUMN terms_version TEXT;
