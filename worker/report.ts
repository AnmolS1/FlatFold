// Abuse reporting (App Review 1.2: "a mechanism for users to flag objectionable
// content", and acting on reports within 24 hours).
//
// THE SHAPE IS FORCED BY THE ENCRYPTION, and that is the honest story to tell:
// the server cannot read messages, so it cannot be asked "show me what they
// sent". A report therefore carries evidence chosen by the REPORTER, from their
// own device, for the specific messages they picked, after they are shown what is
// being sent. Only a participant can ever disclose their own copy — which is
// exactly the property E2EE is supposed to have, not an exception to it.
//
// Everything below exists to keep that channel narrow: it is the one path that
// writes user-supplied readable text to the server, so it is capped, rate-limited,
// attributable, and swept on a hard retention cap.
import { checkRateLimit } from './db';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;

// Evidence caps. A report is a handful of messages someone points at, not a
// conversation export — without a cap this is an authenticated write-anything
// endpoint wearing a safety feature's clothes.
const MAX_EVIDENCE_MESSAGES = 50;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_REASON_LENGTH = 2000;

// Per-reporter throttle. Generous enough that nobody reporting real abuse hits
// it, tight enough that one account can't bury the queue.
const REPORT_LIMIT = 10;
const REPORT_WINDOW_SECONDS = 3600;

// Hard retention cap, also stated on /transparency and in the terms. Enforced
// opportunistically on insert, the same way rate_limits prunes itself: there is
// no cron on this Worker, and a retention promise that depends on someone
// remembering to run something is not a promise.
const EVIDENCE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { 'Content-Type': 'application/json', ...init.headers },
	});
}

interface EvidenceMessage {
	from: string;
	ts: number;
	text: string;
}

function validEvidence(value: unknown): value is EvidenceMessage[] {
	if (!Array.isArray(value)) return false;
	if (value.length > MAX_EVIDENCE_MESSAGES) return false;
	return value.every(
		(m) =>
			typeof m === 'object' &&
			m !== null &&
			typeof (m as EvidenceMessage).from === 'string' &&
			typeof (m as EvidenceMessage).ts === 'number' &&
			typeof (m as EvidenceMessage).text === 'string'
	);
}

export async function handleReport(request: Request, env: Env, reporter: string): Promise<Response> {
	const body = (await request.json().catch(() => null)) as
		| { reported?: unknown; reason?: unknown; evidence?: unknown }
		| null;

	const reported = body?.reported;
	if (typeof reported !== 'string' || !USERNAME_RE.test(reported)) {
		return json({ error: 'Tell us which account you are reporting.' }, { status: 400 });
	}
	// Self-reporting is meaningless, and would be a free write to your own row.
	if (reported === reporter) {
		return json({ error: 'You cannot report yourself.' }, { status: 400 });
	}

	const reason = body?.reason;
	if (reason !== undefined && (typeof reason !== 'string' || reason.length > MAX_REASON_LENGTH)) {
		return json({ error: 'That description is too long.' }, { status: 400 });
	}

	// Evidence is OPTIONAL by design: consent to attach messages is explicit, so
	// declining to attach any must still file a report.
	let evidenceJson: string | null = null;
	if (body?.evidence !== undefined) {
		if (!validEvidence(body.evidence)) {
			return json({ error: 'That is more than a report can carry. Pick fewer messages.' }, { status: 400 });
		}
		evidenceJson = JSON.stringify(body.evidence);
		if (evidenceJson.length > MAX_EVIDENCE_BYTES) {
			return json({ error: 'That is more than a report can carry. Pick fewer messages.' }, { status: 400 });
		}
	}

	const window = Math.floor(Date.now() / 1000 / REPORT_WINDOW_SECONDS) * REPORT_WINDOW_SECONDS;
	if (!(await checkRateLimit(env.DB, `report:${reporter}`, window, REPORT_LIMIT))) {
		return json({ error: 'Too many reports just now. Please try again later.' }, { status: 429 });
	}

	// Coarsened to the minute, like every other timestamp here.
	const createdAt = Math.floor(Date.now() / 60_000) * 60;
	await env.DB.prepare(
		'INSERT INTO abuse_reports (id, reported_username, reporter_username, created_at, reason, status, evidence) VALUES (?, ?, ?, ?, ?, ?, ?)'
	)
		.bind(crypto.randomUUID(), reported, reporter, createdAt, typeof reason === 'string' ? reason : null, 'new', evidenceJson)
		.run();

	await pruneExpiredReports(env.DB);

	return json({ ok: true });
}

/** Retention sweep: drop anything past the 90-day cap, reviewed or not. */
export async function pruneExpiredReports(db: D1Database): Promise<void> {
	const cutoff = Math.floor(Date.now() / 1000) - EVIDENCE_MAX_AGE_SECONDS;
	await db.prepare('DELETE FROM abuse_reports WHERE created_at < ?').bind(cutoff).run();
}
