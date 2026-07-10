-- Fixed-window rate-limit counters for prekey-bundle lookups. One row per
-- (requester, time window); old windows are deleted opportunistically on the
-- requester's next lookup, so steady-state size is ~one row per recently
-- active requester — not a growing log.
--
-- This caps how FAST one authenticated account can enumerate usernames via
-- the "does this bundle exist" endpoint. It does not stop a determined
-- attacker who spins up many accounts (that's account-creation's problem,
-- out of scope here) — see docs/ARCHITECTURE.md.

CREATE TABLE IF NOT EXISTS rate_limits (
	requester    TEXT NOT NULL,
	window_start INTEGER NOT NULL, -- unix seconds, floored to the window size
	count        INTEGER NOT NULL,
	PRIMARY KEY (requester, window_start)
);
