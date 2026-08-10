// App Review 1.2: the EULA gate. Every account must accept the terms before the
// app is usable, and that has to be enforced on the SERVER — a client-side-only
// gate is one devtools call away from being skipped, and the reviewer is told
// the agreement is universal.
import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { TERMS_VERSION } from '../shared/terms';

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

async function me(cookie: string): Promise<{ termsAccepted?: boolean }> {
	const res = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } });
	return (await res.json()) as { termsAccepted?: boolean };
}

describe('terms acceptance gate', () => {
	it('a brand-new account has NOT accepted the terms', async () => {
		const cookie = await signup('terms_fresh');
		expect((await me(cookie)).termsAccepted).toBe(false);
	});

	it('accepting flips /me and records the timestamp and version', async () => {
		const cookie = await signup('terms_accept');

		const res = await SELF.fetch(`${BASE}/api/account/accept-terms`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
		});
		expect(res.status).toBe(200);

		expect((await me(cookie)).termsAccepted).toBe(true);

		const row = await env.DB.prepare('SELECT terms_accepted_at, terms_version FROM users WHERE username = ?')
			.bind('terms_accept')
			.first<{ terms_accepted_at: number | null; terms_version: string | null }>();
		expect(row?.terms_version).toBe(TERMS_VERSION);
		expect(typeof row?.terms_accepted_at).toBe('number');
		// Coarsened to the minute, like created_at.
		expect(row!.terms_accepted_at! % 60).toBe(0);
	});

	it('ignores a client-supplied version — the server decides what was accepted', async () => {
		const cookie = await signup('terms_spoof');

		await SELF.fetch(`${BASE}/api/account/accept-terms`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ version: '9999-12-31' }),
		});

		const row = await env.DB.prepare('SELECT terms_version FROM users WHERE username = ?')
			.bind('terms_spoof')
			.first<{ terms_version: string | null }>();
		// A stored future version would let this account skip the NEXT re-gate.
		expect(row?.terms_version).toBe(TERMS_VERSION);
	});

	it('an account that accepted an OLDER version is gated again', async () => {
		const cookie = await signup('terms_stale');
		await env.DB.prepare('UPDATE users SET terms_accepted_at = ?, terms_version = ? WHERE username = ?')
			.bind(1_700_000_000, '1999-01-01', 'terms_stale')
			.run();

		expect((await me(cookie)).termsAccepted).toBe(false);
	});

	it('rejects an unauthenticated acceptance', async () => {
		const res = await SELF.fetch(`${BASE}/api/account/accept-terms`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
		});
		expect(res.status).toBe(401);
	});
});
