// D7 §3 — account-recovery endpoints. The client-side recovery crypto (deriving
// the authenticator + wrap key from the code) is tested in test-ui/recovery*.ts;
// here the authenticator is an OPAQUE string the server only hashes/verifies, so
// these tests exercise the full server logic (enroll → params → reset) without
// needing hash-wasm (banned in workerd).
import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

const BASE = 'https://example.com';

function cookie(res: Response): string {
	const c = res.headers.get('Set-Cookie');
	if (!c) throw new Error('expected Set-Cookie');
	return c.split(';')[0];
}

async function signup(username: string, password: string): Promise<string> {
	const res = await SELF.fetch(`${BASE}/api/auth/signup`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password }),
	});
	return cookie(res);
}
const login = (username: string, password: string) =>
	SELF.fetch(`${BASE}/api/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password }),
	});
const me = (c: string) => SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: c } });
const enroll = (c: string, payload: Record<string, unknown>) =>
	SELF.fetch(`${BASE}/api/auth/recovery/enroll`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Cookie: c },
		body: JSON.stringify(payload),
	});
const params = (username: string) => SELF.fetch(`${BASE}/api/auth/recovery/params?username=${username}`);
const reset = (payload: Record<string, unknown>) =>
	SELF.fetch(`${BASE}/api/auth/recovery/reset`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});

const GOOD = { password: 'old-password-1', saltRec: 'salt-rec', saltAuth: 'salt-auth', blob: 'OPAQUE-BLOB', auth: 'AUTHVALUE' };

describe('recovery enrollment', () => {
	it('enrolls with the correct password, then serves the public salts', async () => {
		const c = await signup('rec_enroll_ok', 'old-password-1');
		expect((await enroll(c, GOOD)).status).toBe(200);

		const p = await params('rec_enroll_ok');
		expect(p.status).toBe(200);
		expect(await p.json()).toEqual({ saltRec: 'salt-rec', saltAuth: 'salt-auth' });
	});

	it('rejects enrollment with a wrong password (no session-only backdoor)', async () => {
		const c = await signup('rec_enroll_badpw', 'old-password-1');
		expect((await enroll(c, { ...GOOD, password: 'wrong' })).status).toBe(401);
		expect((await params('rec_enroll_badpw')).status).toBe(404); // nothing stored
	});

	it('requires authentication to enroll', async () => {
		const res = await SELF.fetch(`${BASE}/api/auth/recovery/enroll`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(GOOD),
		});
		expect(res.status).toBe(401);
	});

	it('params 404s for an account with no recovery enrolled', async () => {
		await signup('rec_norecovery', 'old-password-1');
		expect((await params('rec_norecovery')).status).toBe(404);
	});
});

describe('recovery reset', () => {
	it('resets with the correct authenticator: releases the blob, new password works, old fails', async () => {
		const c = await signup('rec_reset_ok', 'old-password-1');
		await enroll(c, GOOD);

		const res = await reset({ username: 'rec_reset_ok', recAuth: 'AUTHVALUE', newPassword: 'new-password-2' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ blob: 'OPAQUE-BLOB' });
		expect(res.headers.get('Set-Cookie')).toBeTruthy(); // web gets a fresh session

		expect((await login('rec_reset_ok', 'new-password-2')).status).toBe(200);
		expect((await login('rec_reset_ok', 'old-password-1')).status).toBe(401);
	});

	it('revokes the pre-reset session (epoch bump)', async () => {
		const c = await signup('rec_reset_epoch', 'old-password-1');
		await enroll(c, GOOD);
		expect((await me(c)).status).toBe(200);
		await reset({ username: 'rec_reset_epoch', recAuth: 'AUTHVALUE', newPassword: 'new-password-2' });
		expect((await me(c)).status).toBe(401);
	});

	it('rejects a wrong authenticator (401) and does not change the password', async () => {
		const c = await signup('rec_reset_badauth', 'old-password-1');
		await enroll(c, GOOD);
		expect((await reset({ username: 'rec_reset_badauth', recAuth: 'WRONG', newPassword: 'new-password-2' })).status).toBe(401);
		expect((await login('rec_reset_badauth', 'old-password-1')).status).toBe(200); // unchanged
	});

	it('rejects reset for an account with no recovery enrolled (401, generic)', async () => {
		await signup('rec_reset_none', 'old-password-1');
		expect((await reset({ username: 'rec_reset_none', recAuth: 'AUTHVALUE', newPassword: 'new-password-2' })).status).toBe(401);
	});

	it('rejects a too-short new password (400)', async () => {
		const c = await signup('rec_reset_weak', 'old-password-1');
		await enroll(c, GOOD);
		expect((await reset({ username: 'rec_reset_weak', recAuth: 'AUTHVALUE', newPassword: 'short' })).status).toBe(400);
	});
});
