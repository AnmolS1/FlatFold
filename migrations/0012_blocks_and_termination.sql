-- App Review 1.2: "a mechanism to block abusive users", and "eject the user"
-- when a report is upheld.
--
-- WHY BLOCKING MOVES TO THE SERVER. It already worked client-side
-- (src/lib/blocklist.ts) but only per-device and only by discarding what had
-- already been delivered. That is real, and it is also easy to describe to a
-- reviewer as cosmetic. With a server-side row the recipient's mailbox simply
-- refuses the delivery, so a blocked account cannot reach the device at all, the
-- block survives a reinstall, and it applies on every device at once.
--
-- HONEST LIMIT, stated here because it is the kind of thing that gets quietly
-- overclaimed: this cannot apply to a SEALED (sender-hidden) send, because the
-- server genuinely does not know who the sender is — that is the entire point of
-- sealed sender. The client-side block still catches those on receipt. Server
-- enforcement covers the normal path; the client covers both.
CREATE TABLE IF NOT EXISTS blocks (
	blocker TEXT NOT NULL,
	blocked TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (blocker, blocked)
);

-- Ejecting an account. A disabled account fails authentication, so every session
-- dies and nothing can be sent or received; its queued ciphertext is purged the
-- same way account deletion purges it.
--
-- DO NOT CLAIM THIS IS PERMANENT. Identity here is a username with no email, no
-- phone and deliberately no IP logging, so a determined person can register
-- again. Apple's wording is "eject", not "permanently bar", and Signal and
-- Session have exactly the same property. What IS durable is that the handle
-- itself is retired below, so the account someone was being abused by cannot
-- simply be re-created.
ALTER TABLE users ADD COLUMN disabled_at INTEGER;

CREATE TABLE IF NOT EXISTS banned_usernames (
	username TEXT PRIMARY KEY,
	banned_at INTEGER NOT NULL
);
