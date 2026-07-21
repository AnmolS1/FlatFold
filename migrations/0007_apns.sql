-- APNs push subscriptions (Phase 1: native iOS). Native clients run in a
-- WKWebView, which has NO Service Worker, so they can't use Web Push at all —
-- they register an APNs device token instead. This is the SAME content-free
-- "wake up and sync" signal as Web Push (migration 0004): the push we send
-- carries ONLY {"aps":{"content-available":1}} — never message text, never a
-- sender. We store ONLY the opaque device token and which APNs environment it
-- belongs to. One row per device; deleted on unsubscribe, on a 410 from APNs
-- (the token is no longer valid), or on account deletion.
--
-- This is server-persisted state and MUST be listed on the /transparency page
-- (src/data/serverState.ts) alongside users / one_time_prekeys / rate_limits /
-- push_subscriptions — the schema-drift guard enforces it.

CREATE TABLE IF NOT EXISTS apns_subscriptions (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	username      TEXT NOT NULL REFERENCES users(username),
	device_token  TEXT NOT NULL UNIQUE,                 -- APNs device token (hex); opaque, no content
	environment   TEXT NOT NULL DEFAULT 'production',   -- 'production' | 'sandbox'
	created_at    INTEGER NOT NULL                      -- unix seconds
);

CREATE INDEX IF NOT EXISTS idx_apns_subscriptions_username ON apns_subscriptions(username);
