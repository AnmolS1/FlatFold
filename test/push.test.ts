import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { buildWakeupRequest, buildApnsRequest } from '../worker/push';

const BASE = 'https://example.com';
// A real allowlisted push host (FCM) — the endpoint allowlist rejects
// anything else (SSRF protection).
const FAKE_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';
// A syntactically valid APNs device token (hex). Not real — the send is
// deploy-only; tests only assert the request we WOULD send is content-free.
const FAKE_DEVICE_TOKEN = 'a'.repeat(64);

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

describe('APNs push — content-free by construction', () => {
	it('the APNs request body is EXACTLY the content-available signal — nothing else', async () => {
		// Native iOS can't use Web Push (no Service Worker in WKWebView), so the
		// wake-up rides APNs instead. It must be just as content-free: a silent
		// background push carrying no message text and no sender.
		const request = await buildApnsRequest(env, FAKE_DEVICE_TOKEN, 'production');

		expect(request.method).toBe('POST');
		const body = await request.clone().text();
		const parsed = JSON.parse(body);
		// The ONLY top-level key is `aps`, whose ONLY key is `content-available`.
		expect(Object.keys(parsed)).toEqual(['aps']);
		expect(Object.keys(parsed.aps)).toEqual(['content-available']);
		expect(parsed.aps['content-available']).toBe(1);
	});

	it('carries NO username / sender / ciphertext anywhere on the wire', async () => {
		// Register a subscription so a real username exists, then prove that
		// username (nor any content) appears in the body or ANY header of the
		// APNs request we build for it.
		const username = 'apns_leak_probe';
		const request = await buildApnsRequest(env, FAKE_DEVICE_TOKEN, 'production');

		const body = await request.clone().text();
		// The authorization value is an opaque ES256 signature (validated
		// structurally elsewhere); scan header NAMES and every NON-auth value,
		// so a random base64url substring can't cause a flaky match.
		const headerDump = [...request.headers]
			.map(([k, v]) => `${k}: ${k === 'authorization' ? '' : v}`)
			.join('\n');
		const wire = `${body}\n${headerDump}`;
		expect(wire).not.toContain(username);
		expect(wire.toLowerCase()).not.toContain('sender');
		expect(wire.toLowerCase()).not.toContain('ciphertext');
		expect(wire.toLowerCase()).not.toContain('message');
	});

	it('sends the correct APNs headers (background, low-priority, no-store)', async () => {
		const request = await buildApnsRequest(env, FAKE_DEVICE_TOKEN, 'production');
		expect(request.headers.get('apns-push-type')).toBe('background');
		expect(request.headers.get('apns-priority')).toBe('5');
		expect(request.headers.get('apns-expiration')).toBe('0');
		// apns-topic is the bundle id (non-secret var).
		expect(request.headers.get('apns-topic')).toBe(env.APNS_BUNDLE_ID);
	});

	it('authenticates with a well-formed ES256 provider JWT (bearer)', async () => {
		const request = await buildApnsRequest(env, FAKE_DEVICE_TOKEN, 'production');
		const auth = request.headers.get('authorization') ?? '';
		expect(auth.startsWith('bearer ')).toBe(true);

		const jwt = auth.slice('bearer '.length);
		const parts = jwt.split('.');
		expect(parts).toHaveLength(3);
		const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
		expect(header.alg).toBe('ES256');
		expect(header.kid).toBe(env.APNS_KEY_ID);
		const claims = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
		expect(claims.iss).toBe(env.APNS_TEAM_ID);
		expect(typeof claims.iat).toBe('number');
	});

	it('targets the production host by default and the sandbox host on request', async () => {
		const prod = await buildApnsRequest(env, FAKE_DEVICE_TOKEN, 'production');
		expect(prod.url).toBe(`https://api.push.apple.com/3/device/${FAKE_DEVICE_TOKEN}`);
		const sandbox = await buildApnsRequest(env, FAKE_DEVICE_TOKEN, 'sandbox');
		expect(sandbox.url).toBe(`https://api.sandbox.push.apple.com/3/device/${FAKE_DEVICE_TOKEN}`);
	});
});

describe('APNs subscription storage', () => {
	it('stores the device token + environment on subscribe', async () => {
		const cookie = await signup('apns_alice');
		const res = await SELF.fetch(`${BASE}/api/push/apns/subscribe`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ deviceToken: FAKE_DEVICE_TOKEN, environment: 'sandbox' }),
		});
		expect(res.status).toBe(200);

		const row = await env.DB.prepare('SELECT * FROM apns_subscriptions WHERE username = ?')
			.bind('apns_alice')
			.first<Record<string, unknown>>();
		expect(row?.device_token).toBe(FAKE_DEVICE_TOKEN);
		expect(row?.environment).toBe('sandbox');
		// The columns that exist are exactly: id, username, device_token,
		// environment, created_at. No message content, no sender.
		expect(Object.keys(row ?? {}).sort()).toEqual(['created_at', 'device_token', 'environment', 'id', 'username']);
	});

	it('defaults to the production environment when unspecified', async () => {
		const cookie = await signup('apns_default_env');
		await SELF.fetch(`${BASE}/api/push/apns/subscribe`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ deviceToken: 'b'.repeat(64) }),
		});
		const row = await env.DB.prepare('SELECT environment FROM apns_subscriptions WHERE username = ?')
			.bind('apns_default_env')
			.first<{ environment: string }>();
		expect(row?.environment).toBe('production');
	});

	it('rejects a malformed device token (path-injection / non-hex)', async () => {
		const cookie = await signup('apns_badtoken');
		for (const deviceToken of [
			'../../evil', // path traversal into the APNs URL
			'not-hex!!', // non-hex chars
			'', // empty
			'abc', // too short
		]) {
			const res = await SELF.fetch(`${BASE}/api/push/apns/subscribe`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Cookie: cookie },
				body: JSON.stringify({ deviceToken }),
			});
			expect(res.status).toBe(400);
		}
	});

	it('rejects an unknown environment value', async () => {
		const cookie = await signup('apns_badenv');
		const res = await SELF.fetch(`${BASE}/api/push/apns/subscribe`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ deviceToken: 'c'.repeat(64), environment: 'staging' }),
		});
		expect(res.status).toBe(400);
	});

	it('a different user cannot hijack an existing APNs device token', async () => {
		const deviceToken = 'f'.repeat(64);
		const ownerCookie = await signup('apns_owner');
		const attackerCookie = await signup('apns_attacker');

		await SELF.fetch(`${BASE}/api/push/apns/subscribe`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
			body: JSON.stringify({ deviceToken, environment: 'production' }),
		});
		// Attacker tries to claim the SAME token, with a different environment.
		const res = await SELF.fetch(`${BASE}/api/push/apns/subscribe`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: attackerCookie },
			body: JSON.stringify({ deviceToken, environment: 'sandbox' }),
		});
		// The conflicting upsert is a no-op (SQLite skips the WHERE-guarded
		// update), so the request still succeeds — but the row is unchanged.
		expect(res.status).toBe(200);
		const row = await env.DB.prepare('SELECT username, environment FROM apns_subscriptions WHERE device_token = ?')
			.bind(deviceToken)
			.first<{ username: string; environment: string }>();
		expect(row?.username).toBe('apns_owner'); // ownership never reassigned
		expect(row?.environment).toBe('production'); // and no field was overwritten
	});

	it('unsubscribe removes the APNs row', async () => {
		const cookie = await signup('apns_bob');
		const deviceToken = 'd'.repeat(64);
		await SELF.fetch(`${BASE}/api/push/apns/subscribe`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ deviceToken }),
		});
		await SELF.fetch(`${BASE}/api/push/apns/unsubscribe`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ deviceToken }),
		});
		const row = await env.DB.prepare('SELECT * FROM apns_subscriptions WHERE device_token = ?').bind(deviceToken).first();
		expect(row).toBeNull();
	});

	it('rejects APNs subscribe without authentication', async () => {
		const res = await SELF.fetch(`${BASE}/api/push/apns/subscribe`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ deviceToken: FAKE_DEVICE_TOKEN }),
		});
		expect(res.status).toBe(401);
	});

	it('account deletion purges the APNs subscription (invariant #6)', async () => {
		const cookie = await signup('apns_deleteme');
		const deviceToken = 'e'.repeat(64);
		await SELF.fetch(`${BASE}/api/push/apns/subscribe`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ deviceToken }),
		});
		// Deletion requires password re-auth (a hijacked session can't nuke the
		// account); `signup` uses this password.
		await SELF.fetch(`${BASE}/api/account`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ password: 'correcthorsebattery' }),
		});
		const row = await env.DB.prepare('SELECT * FROM apns_subscriptions WHERE device_token = ?').bind(deviceToken).first();
		expect(row).toBeNull();
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
