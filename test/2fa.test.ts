// D7 §4 — TOTP two-factor endpoints, end to end. Because these run in workerd,
// the test computes REAL codes with the same worker/totp functions the server
// uses, then drives enable → login-gate → login-with-code → backup-code → disable.
import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { base32 } from '@scure/base';
import { computeTotp, totpStep } from '../worker/totp';

const BASE = 'https://example.com';
const SECRET = base32.encode(new TextEncoder().encode('12345678901234567890'));
const SECRET_BYTES = base32.decode(SECRET);
const BACKUP = ['aaaa-bbbb-cccc', 'dddd-eeee-ffff'];

const validCode = () => computeTotp(SECRET_BYTES, totpStep(Date.now()));

function cookie(res: Response): string {
	const c = res.headers.get('Set-Cookie');
	if (!c) throw new Error('expected Set-Cookie');
	return c.split(';')[0];
}
async function signup(username: string, password = 'password-1234'): Promise<string> {
	const res = await SELF.fetch(`${BASE}/api/auth/signup`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password }),
	});
	return cookie(res);
}
const login = (username: string, body: Record<string, unknown>) =>
	SELF.fetch(`${BASE}/api/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, ...body }),
	});
const enable = (c: string, body: Record<string, unknown>) =>
	SELF.fetch(`${BASE}/api/auth/2fa/enable`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Cookie: c },
		body: JSON.stringify(body),
	});
const disable = (c: string, body: Record<string, unknown>) =>
	SELF.fetch(`${BASE}/api/auth/2fa/disable`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Cookie: c },
		body: JSON.stringify(body),
	});

async function enrolled(username: string): Promise<string> {
	const c = await signup(username);
	const res = await enable(c, { password: 'password-1234', secret: SECRET, code: await validCode(), backupCodes: BACKUP });
	expect(res.status).toBe(200);
	return c;
}

describe('2FA enable', () => {
	it('enables with the correct password + a confirming code', async () => {
		await enrolled('tfa_enable_ok');
	});

	it('rejects enable with a wrong password', async () => {
		const c = await signup('tfa_enable_badpw');
		expect((await enable(c, { password: 'nope', secret: SECRET, code: await validCode(), backupCodes: BACKUP })).status).toBe(401);
		// still single-factor
		expect((await login('tfa_enable_badpw', { password: 'password-1234' })).status).toBe(200);
	});

	it('rejects enable with a non-matching confirm code', async () => {
		const c = await signup('tfa_enable_badcode');
		expect((await enable(c, { password: 'password-1234', secret: SECRET, code: '000000', backupCodes: BACKUP })).status).toBe(401);
	});

	it('requires authentication', async () => {
		const res = await SELF.fetch(`${BASE}/api/auth/2fa/enable`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ password: 'password-1234', secret: SECRET, code: '000000', backupCodes: BACKUP }),
		});
		expect(res.status).toBe(401);
	});
});

describe('2FA login gate', () => {
	it('password alone returns twoFactorRequired, code completes it', async () => {
		await enrolled('tfa_login');
		const gate = await login('tfa_login', { password: 'password-1234' });
		expect(gate.status).toBe(401);
		expect(await gate.json()).toMatchObject({ twoFactorRequired: true });

		const done = await login('tfa_login', { password: 'password-1234', code: await validCode() });
		expect(done.status).toBe(200);
		expect(done.headers.get('Set-Cookie')).toBeTruthy();
	});

	it('rejects a wrong code (still twoFactorRequired)', async () => {
		await enrolled('tfa_login_wrong');
		const res = await login('tfa_login_wrong', { password: 'password-1234', code: '000000' });
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ twoFactorRequired: true });
	});

	it('a backup code logs in once, then is spent', async () => {
		await enrolled('tfa_backup');
		expect((await login('tfa_backup', { password: 'password-1234', code: 'aaaa-bbbb-cccc' })).status).toBe(200);
		// same backup code no longer works
		expect((await login('tfa_backup', { password: 'password-1234', code: 'aaaa-bbbb-cccc' })).status).toBe(401);
		// the other one still does
		expect((await login('tfa_backup', { password: 'password-1234', code: 'dddd-eeee-ffff' })).status).toBe(200);
	});

	it('replay: the same TOTP code cannot be used twice', async () => {
		await enrolled('tfa_replay');
		const code = await validCode();
		expect((await login('tfa_replay', { password: 'password-1234', code })).status).toBe(200);
		expect((await login('tfa_replay', { password: 'password-1234', code })).status).toBe(401);
	});
});

describe('2FA disable', () => {
	it('disables with password + a valid code, then login needs no code', async () => {
		const c = await enrolled('tfa_disable');
		expect((await disable(c, { password: 'password-1234', code: await validCode() })).status).toBe(200);
		expect((await login('tfa_disable', { password: 'password-1234' })).status).toBe(200);
	});

	it('rejects disable without a valid code', async () => {
		const c = await enrolled('tfa_disable_nocode');
		expect((await disable(c, { password: 'password-1234', code: '000000' })).status).toBe(401);
		// still enforced
		expect((await login('tfa_disable_nocode', { password: 'password-1234' })).status).toBe(401);
	});
});
