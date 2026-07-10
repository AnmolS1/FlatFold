-- Web Push subscriptions (M6). FlatFold's push is payload-LESS — a
-- content-free "wake up and sync" signal — so we store ONLY the push
-- endpoint, never the p256dh/auth payload-encryption keys (there is no
-- payload to encrypt). One row per (device) subscription; deleted on
-- unsubscribe, on a 410/404 from the push service, or on account deletion.
--
-- This is server-persisted state and MUST be listed on the /transparency
-- page alongside users / one_time_prekeys / rate_limits.

CREATE TABLE IF NOT EXISTS push_subscriptions (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	username    TEXT NOT NULL REFERENCES users(username),
	endpoint    TEXT NOT NULL UNIQUE, -- the push service URL; opaque, no content
	created_at  INTEGER NOT NULL      -- unix seconds
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_username ON push_subscriptions(username);
