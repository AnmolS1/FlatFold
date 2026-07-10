import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';

const BASE = 'https://example.com';

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

describe('encrypted media relay', () => {
	it('uploads ciphertext, returns an id, and serves it back byte-for-byte', async () => {
		const cookie = await signup('media_alice');
		const ciphertext = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);

		const uploadRes = await SELF.fetch(`${BASE}/api/media`, {
			method: 'POST',
			headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
			body: ciphertext,
		});
		expect(uploadRes.status).toBe(200);
		const { id } = (await uploadRes.json()) as { id: string };
		expect(typeof id).toBe('string');

		const downloadRes = await SELF.fetch(`${BASE}/api/media/${id}`, { headers: { Cookie: cookie } });
		expect(downloadRes.status).toBe(200);
		const back = new Uint8Array(await downloadRes.arrayBuffer());
		expect([...back]).toEqual([...ciphertext]);
	});

	it('deletes on fetch-ack and 404s afterward', async () => {
		const cookie = await signup('media_bob');
		const uploadRes = await SELF.fetch(`${BASE}/api/media`, {
			method: 'POST',
			headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
			body: new Uint8Array([1, 2, 3]),
		});
		const { id } = (await uploadRes.json()) as { id: string };

		const delRes = await SELF.fetch(`${BASE}/api/media/${id}`, { method: 'DELETE', headers: { Cookie: cookie } });
		expect(delRes.status).toBe(204);

		const afterRes = await SELF.fetch(`${BASE}/api/media/${id}`, { headers: { Cookie: cookie } });
		expect(afterRes.status).toBe(404);
	});

	it('requires authentication for upload, download, and delete', async () => {
		const uploadRes = await SELF.fetch(`${BASE}/api/media`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/octet-stream' },
			body: new Uint8Array([1]),
		});
		expect(uploadRes.status).toBe(401);

		const downloadRes = await SELF.fetch(`${BASE}/api/media/some-id`);
		expect(downloadRes.status).toBe(401);

		const deleteRes = await SELF.fetch(`${BASE}/api/media/some-id`, { method: 'DELETE' });
		expect(deleteRes.status).toBe(401);
	});

	it('rejects an empty upload body', async () => {
		const cookie = await signup('media_carol');
		const res = await SELF.fetch(`${BASE}/api/media`, {
			method: 'POST',
			headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
		});
		expect(res.status).toBe(400);
	});
});

describe('media upload rate limit (M3)', () => {
	it('returns 429 and does not write to R2 once the per-user upload rate is exceeded', async () => {
		const cookie = await signup('media_flood');
		const LIMIT = 20; // MEDIA_UPLOAD_LIMIT
		const window = Math.floor(Date.now() / 1000 / 60) * 60; // MEDIA_UPLOAD_WINDOW_SECONDS = 60
		// Saturate this user's media bucket for the current window.
		await env.DB.prepare(
			'INSERT INTO rate_limits (requester, window_start, count) VALUES (?, ?, ?) ON CONFLICT(requester, window_start) DO UPDATE SET count = excluded.count'
		)
			.bind('media:media_flood', window, LIMIT)
			.run();

		const before = (await env.MEDIA.list()).objects.length;
		const res = await SELF.fetch(`${BASE}/api/media`, {
			method: 'POST',
			headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
			body: new Uint8Array([1, 2, 3, 4]),
		});
		expect(res.status).toBe(429);
		expect((await env.MEDIA.list()).objects.length).toBe(before); // nothing written
	});
});
