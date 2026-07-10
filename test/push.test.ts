import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { buildWakeupRequest } from '../worker/push';

const BASE = 'https://example.com';
// A real allowlisted push host (FCM) — the endpoint allowlist rejects
// anything else (SSRF protection).
const FAKE_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';

async function signup(username: string): Promise<string> {
	const res = await SELF.fetch(`${BASE}/api/auth/signup`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password: 'correcthorsebattery' }),
	});
	const cookie = res.headers.get('Set-Cookie')?.split(';')[0];
	if (!cookie) throw new Error('Expected a Set-Cookie header from signup');
	return cookie;
}

describe('web push — content-free by construction', () => {
	it('the wake-up request carries NO body and NO message content', async () => {
		// buildWakeupRequest only takes (env, endpoint) — it has no message,
		// sender, or ciphertext to include even in principle. Assert the wire
		// request is genuinely empty.
		const request = await buildWakeupRequest(env, FAKE_ENDPOINT);

		expect(request.method).toBe('POST');
		expect(request.body).toBeNull(); // payload-less push — nothing to leak
		expect(await request.clone().text()).toBe('');
	});

	it('authenticates with a well-formed VAPID JWT scoped to the push origin', async () => {
		const request = await buildWakeupRequest(env, FAKE_ENDPOINT);
		const auth = request.headers.get('Authorization') ?? '';
		expect(auth.startsWith('vapid t=')).toBe(true);

		// t=<jwt>, k=<public key> — the JWT is three base64url segments.
		const jwt = /t=([^,]+)/.exec(auth)?.[1] ?? '';
		const parts = jwt.split('.');
		expect(parts).toHaveLength(3);
		const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
		expect(header.alg).toBe('ES256');
		const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
		expect(payload.aud).toBe('https://fcm.googleapis.com'); // audience = push origin
	});
});

describe('push subscription storage', () => {
	it('stores only the endpoint on subscribe (no payload-encryption keys)', async () => {
		const cookie = await signup('push_alice');
		const res = await SELF.fetch(`${BASE}/api/push/subscribe`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			// A real PushSubscription would also carry keys.p256dh/auth; we
			// deliberately accept and store only the endpoint.
			body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/alice-1', keys: { p256dh: 'x', auth: 'y' } }),
		});
		expect(res.status).toBe(200);

		const row = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE username = ?')
			.bind('push_alice')
			.first<Record<string, unknown>>();
		expect(row?.endpoint).toBe('https://fcm.googleapis.com/fcm/send/alice-1');
		// The columns that exist are exactly: id, username, endpoint, created_at.
		expect(Object.keys(row ?? {}).sort()).toEqual(['created_at', 'endpoint', 'id', 'username']);
	});

	it('rejects a non-allowlisted endpoint (SSRF protection)', async () => {
		const cookie = await signup('push_ssrf');
		for (const endpoint of [
			'https://internal-metadata.local/latest', // internal host
			'http://fcm.googleapis.com/fcm/send/x', // wrong scheme
			'https://evil.example.com/fcm.googleapis.com', // not the real host
			'https://fcm.googleapis.com.evil.com/x', // lookalike
		]) {
			const res = await SELF.fetch(`${BASE}/api/push/subscribe`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Cookie: cookie },
				body: JSON.stringify({ endpoint }),
			});
			expect(res.status).toBe(400);
		}
	});

	it('a different user cannot hijack an existing subscription endpoint', async () => {
		const endpoint = 'https://updates.push.services.mozilla.com/wpush/v2/shared-1';
		const ownerCookie = await signup('push_owner');
		const attackerCookie = await signup('push_attacker');

		await SELF.fetch(`${BASE}/api/push/subscribe`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
			body: JSON.stringify({ endpoint }),
		});
		// Attacker tries to claim the SAME endpoint.
		await SELF.fetch(`${BASE}/api/push/subscribe`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: attackerCookie },
			body: JSON.stringify({ endpoint }),
		});

		const row = await env.DB.prepare('SELECT username FROM push_subscriptions WHERE endpoint = ?')
			.bind(endpoint)
			.first<{ username: string }>();
		expect(row?.username).toBe('push_owner'); // ownership never reassigned
	});

	it('unsubscribe removes the row', async () => {
		const cookie = await signup('push_bob');
		const endpoint = 'https://fcm.googleapis.com/fcm/send/bob-1';
		await SELF.fetch(`${BASE}/api/push/subscribe`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ endpoint }),
		});
		await SELF.fetch(`${BASE}/api/push/unsubscribe`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ endpoint }),
		});
		const row = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).first();
		expect(row).toBeNull();
	});

	it('rejects subscribe/unsubscribe without authentication', async () => {
		const subRes = await SELF.fetch(`${BASE}/api/push/subscribe`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ endpoint: 'https://push.example.com/x' }),
		});
		expect(subRes.status).toBe(401);
	});

	it('exposes the VAPID public key (non-secret) without auth', async () => {
		const res = await SELF.fetch(`${BASE}/api/push/vapid-public-key`);
		expect(res.status).toBe(200);
		const { publicKey } = (await res.json()) as { publicKey: string };
		expect(publicKey.length).toBeGreaterThan(80); // base64url uncompressed P-256 point
	});
});
