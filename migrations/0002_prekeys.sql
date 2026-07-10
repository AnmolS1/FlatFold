-- One-time prekeys for X3DH. One row per key; a row is deleted the moment
-- a bundle fetch consumes it (worker/keys.ts, a single atomic
-- DELETE...RETURNING) — so this table's steady-state size is "keys
-- published minus keys already consumed by a new conversation," not a
-- growing log. Still the whole server-side store is auditable by reading
-- this file plus 0001_init.sql.

CREATE TABLE IF NOT EXISTS one_time_prekeys (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	username    TEXT NOT NULL REFERENCES users(username),
	public_key  TEXT NOT NULL,
	created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_one_time_prekeys_username ON one_time_prekeys(username);
