import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

const BASE = 'https://example.com';

function extractSessionCookie(response: Response): string {
	const setCookie = response.headers.get('Set-Cookie');
	if (!setCookie) throw new Error('Expected a Set-Cookie header on the response');
	return setCookie.split(';')[0];
}

describe('auth', () => {
	it('signs up, then reads /me, then logs in again with the same session', async () => {
		const signupRes = await SELF.fetch(`${BASE}/api/auth/signup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'alice_vitest', password: 'correcthorsebattery' }),
		});
		expect(signupRes.status).toBe(200);
		const cookie = extractSessionCookie(signupRes);

		const meRes = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } });
		expect(meRes.status).toBe(200);
		const me = (await meRes.json()) as { username: string; sessionCreatedAt: number };
		expect(me.username).toBe('alice_vitest');
		expect(typeof me.sessionCreatedAt).toBe('number'); // powers the session manager

		const loginRes = await SELF.fetch(`${BASE}/api/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'alice_vitest', password: 'correcthorsebattery' }),
		});
		expect(loginRes.status).toBe(200);
		expect(await loginRes.json()).toEqual({ username: 'alice_vitest' });
	});

	it('rejects signup for a username that already exists', async () => {
		await SELF.fetch(`${BASE}/api/auth/signup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'carol_vitest', password: 'correcthorsebattery' }),
		});

		const dupeRes = await SELF.fetch(`${BASE}/api/auth/signup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'carol_vitest', password: 'anotherpassword' }),
		});
		expect(dupeRes.status).toBe(409);
	});

	it('rejects a wrong password with a generic 401 (no user-enumeration oracle)', async () => {
		await SELF.fetch(`${BASE}/api/auth/signup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'bob_vitest', password: 'correcthorsebattery' }),
		});

		const wrongPasswordRes = await SELF.fetch(`${BASE}/api/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'bob_vitest', password: 'wrongpassword' }),
		});
		expect(wrongPasswordRes.status).toBe(401);

		const noSuchUserRes = await SELF.fetch(`${BASE}/api/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'no_such_user_vitest', password: 'correcthorsebattery' }),
		});
		expect(noSuchUserRes.status).toBe(401);
		// Same error body for "wrong password" and "no such user" — that's the point.
		expect(await wrongPasswordRes.text()).toBe(await noSuchUserRes.text());
	});

	it('rejects an unauthenticated /me', async () => {
		const res = await SELF.fetch(`${BASE}/api/auth/me`);
		expect(res.status).toBe(401);
	});

	it('logout clears the session cookie', async () => {
		const signupRes = await SELF.fetch(`${BASE}/api/auth/signup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'dave_vitest', password: 'correcthorsebattery' }),
		});
		const cookie = extractSessionCookie(signupRes);

		const logoutRes = await SELF.fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
		expect(logoutRes.status).toBe(200);
		const clearedCookie = extractSessionCookie(logoutRes);

		const meRes = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: clearedCookie } });
		expect(meRes.status).toBe(401);
	});
});

describe('password length bounds (L4)', () => {
	it('rejects an over-long password (>1024) to bound Argon2 input', async () => {
		const res = await SELF.fetch(`${BASE}/api/auth/signup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'longpw_user', password: 'x'.repeat(1025) }),
		});
		expect(res.status).toBe(400);
	});
});

describe('session revocation — sign out everywhere (L3)', () => {
	async function signupCookie(u: string): Promise<string> {
		const res = await SELF.fetch(`${BASE}/api/auth/signup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: u, password: 'correcthorsebattery' }),
		});
		return extractSessionCookie(res);
	}
	const me = (cookie: string) => SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } });
	const logoutAll = (cookie: string, password: string) =>
		SELF.fetch(`${BASE}/api/auth/logout-all`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ password }),
		});

	it('correct password bumps the epoch and invalidates the existing session token', async () => {
		const cookie = await signupCookie('epoch_alice');
		expect((await me(cookie)).status).toBe(200);
		expect((await logoutAll(cookie, 'correcthorsebattery')).status).toBe(200);
		// The old token carries the pre-bump epoch -> now stale -> 401.
		expect((await me(cookie)).status).toBe(401);
	});

	it('requires the password — a wrong password does not revoke', async () => {
		const cookie = await signupCookie('epoch_bob');
		expect((await logoutAll(cookie, 'wrong-password')).status).toBe(401);
		expect((await me(cookie)).status).toBe(200); // session untouched
	});

	it('/api/auth/me slides the session by re-issuing a fresh cookie', async () => {
		const cookie = await signupCookie('epoch_carol');
		const res = await me(cookie);
		expect(res.status).toBe(200);
		expect(res.headers.get('Set-Cookie')).toBeTruthy();
	});
});

describe('change password (D7 §1)', () => {
	async function signupCookie(u: string, password: string): Promise<string> {
		const res = await SELF.fetch(`${BASE}/api/auth/signup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: u, password }),
		});
		return extractSessionCookie(res);
	}
	const me = (cookie: string) => SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } });
	const changePassword = (cookie: string, current: string, next: string) =>
		SELF.fetch(`${BASE}/api/auth/change-password`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ current, new: next }),
		});
	const login = (u: string, password: string) =>
		SELF.fetch(`${BASE}/api/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: u, password }),
		});

	it('changes the password: the new one logs in, the old is rejected', async () => {
		const cookie = await signupCookie('cp_happy', 'old-password-1');
		expect((await changePassword(cookie, 'old-password-1', 'new-password-2')).status).toBe(200);

		expect((await login('cp_happy', 'new-password-2')).status).toBe(200);
		expect((await login('cp_happy', 'old-password-1')).status).toBe(401);
	});

	it('returns a fresh, still-valid token for THIS session (signed at the bumped epoch)', async () => {
		const cookie = await signupCookie('cp_freshtoken', 'old-password-1');
		const res = await changePassword(cookie, 'old-password-1', 'new-password-2');
		expect(res.status).toBe(200);
		// The response re-issues the cookie; it must authenticate /me despite the
		// epoch bump (regression guard: signing at the pre-bump epoch would 401 here).
		const fresh = extractSessionCookie(res);
		expect((await me(fresh)).status).toBe(200);
	});

	it('revokes OTHER existing sessions (epoch bump)', async () => {
		const first = await signupCookie('cp_revoke', 'old-password-1');
		// A second session for the same user (login issues its own cookie).
		const second = extractSessionCookie(await login('cp_revoke', 'old-password-1'));
		expect((await me(second)).status).toBe(200);

		expect((await changePassword(first, 'old-password-1', 'new-password-2')).status).toBe(200);
		// The other session's token carried the pre-bump epoch — now dead.
		expect((await me(second)).status).toBe(401);
	});

	it('rejects a wrong current password (401) and leaves the password unchanged', async () => {
		const cookie = await signupCookie('cp_wrongcurrent', 'old-password-1');
		expect((await changePassword(cookie, 'not-the-password', 'new-password-2')).status).toBe(401);
		// Unchanged: the old password still works, the never-set new one does not.
		expect((await login('cp_wrongcurrent', 'old-password-1')).status).toBe(200);
		expect((await login('cp_wrongcurrent', 'new-password-2')).status).toBe(401);
	});

	it('rejects a too-short new password (400)', async () => {
		const cookie = await signupCookie('cp_weak', 'old-password-1');
		expect((await changePassword(cookie, 'old-password-1', 'short')).status).toBe(400);
	});

	it('requires authentication', async () => {
		const res = await SELF.fetch(`${BASE}/api/auth/change-password`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ current: 'old-password-1', new: 'new-password-2' }),
		});
		expect(res.status).toBe(401);
	});
});
