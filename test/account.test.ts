import { describe, expect, it } from 'vitest';
import { env, runInDurableObject, SELF } from 'cloudflare:test';

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

describe('account deletion (invariant #6)', () => {
	it('requires password re-auth — a session cookie alone cannot delete', async () => {
		const cookie = await signup('del_reauth');

		// Wrong password → rejected, account still exists.
		const wrong = await SELF.fetch(`${BASE}/api/account`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ password: 'not-the-password' }),
		});
		expect(wrong.status).toBe(401);
		expect(await env.DB.prepare('SELECT username FROM users WHERE username = ?').bind('del_reauth').first()).not.toBeNull();

		// Missing password → 400.
		const missing = await SELF.fetch(`${BASE}/api/account`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({}),
		});
		expect(missing.status).toBe(400);
	});

	it('unauthenticated deletion is rejected', async () => {
		const res = await SELF.fetch(`${BASE}/api/account`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ password: PASSWORD }),
		});
		expect(res.status).toBe(401);
	});

	it('synchronously deletes every D1 row AND the mailbox DO storage', async () => {
		const cookie = await signup('del_alice');

		// Seed data across tables: a push subscription + a one-time prekey +
		// a rate-limit row, and a queued ciphertext envelope in the DO.
		await SELF.fetch(`${BASE}/api/push/subscribe`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/del-alice-1' }),
		});
		await env.DB.prepare('INSERT INTO one_time_prekeys (username, public_key, created_at) VALUES (?, ?, ?)')
			.bind('del_alice', 'fake-prekey', 0)
			.run();
		await env.DB.prepare('INSERT INTO rate_limits (requester, window_start, count) VALUES (?, ?, ?)')
			.bind('del_alice', 0, 1)
			.run();

		const stub = env.MAILBOX.getByName('del_alice');
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put('envelope:someone:000000000001:msg1', { ciphertext: 'x' });
			await state.storage.put('sendSeq', 5);
		});

		// Sanity: the DO has state before deletion.
		const before = await runInDurableObject(stub, (_i, state) => state.storage.list());
		expect(before.size).toBeGreaterThan(0);

		// Delete with the correct password.
		const res = await SELF.fetch(`${BASE}/api/account`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ password: PASSWORD }),
		});
		expect(res.status).toBe(200);
		// Session cookie is cleared.
		expect(res.headers.get('Set-Cookie') ?? '').toMatch(/Max-Age=0/);

		// Every D1 row for the user is gone.
		expect(await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind('del_alice').first()).toBeNull();
		expect(await env.DB.prepare('SELECT * FROM one_time_prekeys WHERE username = ?').bind('del_alice').first()).toBeNull();
		expect(await env.DB.prepare('SELECT * FROM push_subscriptions WHERE username = ?').bind('del_alice').first()).toBeNull();
		expect(await env.DB.prepare('SELECT * FROM rate_limits WHERE requester = ?').bind('del_alice').first()).toBeNull();

		// The mailbox DO storage is wiped.
		const after = await runInDurableObject(stub, (_i, state) => state.storage.list());
		expect(after.size).toBe(0);

		// Re-login fails — the account truly no longer exists.
		const relogin = await SELF.fetch(`${BASE}/api/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'del_alice', password: PASSWORD }),
		});
		expect(relogin.status).toBe(401);
	});
});
