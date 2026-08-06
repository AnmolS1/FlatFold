// App Review 1.2: flagging objectionable content, and acting on it.
//
// The interesting constraint is that the server cannot read messages, so it
// cannot look up what was reported — the reporter supplies the evidence from
// their own device. That makes the endpoint's job narrow and its limits sharp:
// take only what was offered, cap it, keep it briefly, and never let the
// reporting channel become a way to write unbounded data to someone else's row.
import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';

const BASE = 'https://example.com';
const PASSWORD = 'correcthorsebattery';

async function signup(username: string): Promise<string> {
	const res = await SELF.fetch(`${BASE}/api/auth/signup`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password: PASSWORD }),
	});
	const cookie = res.headers.get('Set-Cookie')?.split(';')[0];
	if (!cookie) throw new Error('Expected a Set-Cookie header from signup');
	return cookie;
}

function report(cookie: string, body: unknown): Promise<Response> {
	return SELF.fetch(`${BASE}/api/report`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Cookie: cookie },
		body: JSON.stringify(body),
	});
}

describe('abuse reporting', () => {
	it('stores a report with the reporter-supplied evidence', async () => {
		const cookie = await signup('rep_alice');
		await signup('rep_pest');

		const res = await report(cookie, {
			reported: 'rep_pest',
			reason: 'sent unsolicited images',
			evidence: [{ from: 'rep_pest', ts: 1_700_000_000, text: 'the offending message' }],
		});
		expect(res.status).toBe(200);

		const row = await env.DB.prepare('SELECT * FROM abuse_reports WHERE reported_username = ?')
			.bind('rep_pest')
			.first<{ reporter_username: string; status: string; evidence: string; reason: string; created_at: number }>();
		expect(row?.reporter_username).toBe('rep_alice');
		expect(row?.status).toBe('new');
		expect(row?.reason).toBe('sent unsolicited images');
		expect(row?.evidence).toContain('the offending message');
		expect(row!.created_at % 60).toBe(0); // coarsened, like every other timestamp
	});

	it('accepts a report with no evidence at all', async () => {
		// Consent is explicit, so declining to attach messages must still file.
		const cookie = await signup('rep_bob');
		await signup('rep_target');
		expect((await report(cookie, { reported: 'rep_target' })).status).toBe(200);
	});

	it('rejects an unauthenticated report', async () => {
		const res = await SELF.fetch(`${BASE}/api/report`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ reported: 'rep_pest' }),
		});
		expect(res.status).toBe(401);
	});

	it('rejects a malformed or self-directed report', async () => {
		const cookie = await signup('rep_carol');
		expect((await report(cookie, {})).status).toBe(400);
		expect((await report(cookie, { reported: 'not a username!' })).status).toBe(400);
		// Reporting yourself is not a thing, and would be a free write to your own row.
		expect((await report(cookie, { reported: 'rep_carol' })).status).toBe(400);
	});

	it('caps the evidence so the report channel is not unbounded storage', async () => {
		const cookie = await signup('rep_dave');
		await signup('rep_flood');

		const huge = Array.from({ length: 500 }, (_, i) => ({
			from: 'rep_flood',
			ts: 1_700_000_000 + i,
			text: 'x'.repeat(5000),
		}));
		const res = await report(cookie, { reported: 'rep_flood', evidence: huge });
		expect(res.status).toBe(400);

		// Scoped to this reported account: storage is isolated per FILE, not per
		// test, so a global COUNT(*) would also see the earlier cases' rows.
		const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM abuse_reports WHERE reported_username = ?')
			.bind('rep_flood')
			.first<{ n: number }>();
		expect(count?.n).toBe(0);
	});

	it('rate-limits a reporter so one account cannot flood the queue', async () => {
		const cookie = await signup('rep_spammer');
		await signup('rep_victim');

		const statuses: number[] = [];
		for (let i = 0; i < 12; i++) {
			statuses.push((await report(cookie, { reported: 'rep_victim' })).status);
		}
		expect(statuses).toContain(429);
	});

	it('prunes evidence older than the 90-day cap', async () => {
		const cookie = await signup('rep_erin');
		await signup('rep_old');

		const ancient = Math.floor(Date.now() / 1000) - 91 * 24 * 60 * 60;
		await env.DB.prepare(
			'INSERT INTO abuse_reports (id, reported_username, reporter_username, created_at, status, evidence) VALUES (?, ?, ?, ?, ?, ?)'
		)
			.bind('stale-report', 'rep_old', 'rep_erin', ancient, 'reviewed', 'should not survive')
			.run();

		// A retention promise enforced only by someone remembering is not a promise
		// — filing any report sweeps the expired ones.
		await report(cookie, { reported: 'rep_old' });

		const stale = await env.DB.prepare('SELECT id FROM abuse_reports WHERE id = ?').bind('stale-report').first();
		expect(stale).toBeNull();
	});
});
