-- App Review 1.2: "a mechanism for users to flag objectionable content" and
-- "act on reports within 24 hours".
--
-- THE CONSTRAINT THAT SHAPES THIS TABLE: messages are end-to-end encrypted and
-- the server cannot read them. So a report cannot point at a message the server
-- can go and look up — there is nothing to look up. `evidence` is therefore
-- supplied BY THE REPORTER, from their own device, for the specific messages they
-- chose, after an explicit consent step. Only a participant can ever disclose
-- their own copy; that property is preserved exactly.
--
-- `evidence` is consequently the ONLY place on this server where readable message
-- text can exist, and it exists only because a user deliberately put it there.
-- That is why it is disclosed on /transparency, in THREAT_MODEL.md and in the App
-- Privacy label, and why the retention below is a hard cap rather than a habit.
--
-- RETENTION: deleted once the report has been reviewed, and in any case after 90
-- days. Enforced opportunistically on insert (worker/report.ts), the same pattern
-- `rate_limits` uses — there is no cron, and a retention promise that depends on
-- someone remembering is not a retention promise.
--
-- `status` is the operator's workflow state ('new' → 'reviewed'), and is the flag
-- the 24-hour commitment is tracked against.
CREATE TABLE IF NOT EXISTS abuse_reports (
	id TEXT PRIMARY KEY,
	reported_username TEXT NOT NULL,
	reporter_username TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	reason TEXT,
	status TEXT NOT NULL DEFAULT 'new',
	evidence TEXT
);

CREATE INDEX IF NOT EXISTS idx_abuse_reports_status ON abuse_reports (status, created_at);
