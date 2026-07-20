import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';

const BASE = 'https://example.com';

function extractSessionCookie(response: Response): string {
	const setCookie = response.headers.get('Set-Cookie');
	if (!setCookie) throw new Error('Expected a Set-Cookie header on the response');
	return setCookie.split(';')[0];
}

async function signup(username: string): Promise<string> {
	const res = await SELF.fetch(`${BASE}/api/auth/signup`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password: 'correcthorsebattery' }),
	});
	return extractSessionCookie(res);
}

function fakeIdentity(seed: string) {
	return { identityPubkey: { signingPublicKey: `sign-${seed}`, dhPublicKey: `dh-${seed}` }, signedPrekey: { publicKey: `spk-${seed}`, signature: `sig-${seed}` } };
}

describe('key publish + bundle fetch', () => {
	it('publishes keys and fetches them back, consuming one one-time prekey', async () => {
		const bobCookie = await signup('bob_keys');
		const aliceCookie = await signup('alice_keys');

		const publishRes = await SELF.fetch(`${BASE}/api/keys/publish`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: bobCookie },
			body: JSON.stringify({ ...fakeIdentity('bob'), oneTimePreKeys: ['opk-1', 'opk-2', 'opk-3'] }),
		});
		expect(publishRes.status).toBe(200);

		const bundleRes = await SELF.fetch(`${BASE}/api/keys/bundle/bob_keys`, { headers: { Cookie: aliceCookie } });
		expect(bundleRes.status).toBe(200);
		const bundle = (await bundleRes.json()) as {
			identityPubkey: { signingPublicKey: string; dhPublicKey: string };
			signedPrekey: { publicKey: string; signature: string };
			oneTimePreKey: string | null;
			sealToken: string | null;
		};
		expect(bundle.identityPubkey).toEqual({ signingPublicKey: 'sign-bob', dhPublicKey: 'dh-bob' });
		expect(bundle.signedPrekey).toEqual({ publicKey: 'spk-bob', signature: 'sig-bob' });
		expect(['opk-1', 'opk-2', 'opk-3']).toContain(bundle.oneTimePreKey);
		expect(bundle.sealToken).toBeNull(); // no sealed-sender token registered yet
	});

	it('serves a registered sealed-sender delivery token in the bundle (first-contact reach)', async () => {
		const bobCookie = await signup('bob_seal');
		const aliceCookie = await signup('alice_seal');
		await SELF.fetch(`${BASE}/api/keys/publish`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: bobCookie },
			body: JSON.stringify({ ...fakeIdentity('bobseal'), oneTimePreKeys: ['s-opk-1'] }),
		});
		const token = 'tok_' + 'b'.repeat(24);
		await SELF.fetch(`${BASE}/api/seal/register-token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: bobCookie },
			body: JSON.stringify({ token }),
		});

		const bundleRes = await SELF.fetch(`${BASE}/api/keys/bundle/bob_seal`, { headers: { Cookie: aliceCookie } });
		const bundle = (await bundleRes.json()) as { sealToken: string | null };
		expect(bundle.sealToken).toBe(token);
	});

	it('never hands out the same one-time prekey twice, even under concurrent fetches', async () => {
		const carolCookie = await signup('carol_keys');
		// Five DISTINCT requesters — M2 caps OTP consumption to one per requester
		// per window, so draining the pool takes different askers (which is also
		// the realistic case: five different people first-contacting Carol).
		const askers = await Promise.all(['d1', 'd2', 'd3', 'd4', 'd5'].map((n) => signup(`asker_${n}`)));

		await SELF.fetch(`${BASE}/api/keys/publish`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: carolCookie },
			body: JSON.stringify({ ...fakeIdentity('carol'), oneTimePreKeys: ['c-opk-1', 'c-opk-2', 'c-opk-3'] }),
		});

		// Fire five concurrent bundle fetches (distinct requesters) against a pool of three OPKs.
		const responses = await Promise.all(
			askers.map((cookie) => SELF.fetch(`${BASE}/api/keys/bundle/carol_keys`, { headers: { Cookie: cookie } }))
		);
		const oneTimePreKeys = await Promise.all(
			responses.map(async (res) => ((await res.json()) as { oneTimePreKey: string | null }).oneTimePreKey)
		);

		const nonNull = oneTimePreKeys.filter((key): key is string => key !== null);
		expect(nonNull.length).toBe(3); // exactly the three published keys, no more
		expect(new Set(nonNull).size).toBe(3); // no key handed out twice
		expect(oneTimePreKeys.filter((key) => key === null).length).toBe(2); // pool exhausted for the rest
	});

	it('still returns identity + signed prekey once the one-time prekey pool is exhausted', async () => {
		const eveCookie = await signup('eve_keys');
		const frankCookie = await signup('frank_keys');

		await SELF.fetch(`${BASE}/api/keys/publish`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: eveCookie },
			body: JSON.stringify({ ...fakeIdentity('eve'), oneTimePreKeys: [] }),
		});

		const bundleRes = await SELF.fetch(`${BASE}/api/keys/bundle/eve_keys`, { headers: { Cookie: frankCookie } });
		expect(bundleRes.status).toBe(200);
		const bundle = (await bundleRes.json()) as { oneTimePreKey: string | null };
		expect(bundle.oneTimePreKey).toBeNull();
	});

	it('404s for a username that does not exist', async () => {
		const aliceCookie = await signup('alice_keys_2');
		const res = await SELF.fetch(`${BASE}/api/keys/bundle/no_such_user_keys`, { headers: { Cookie: aliceCookie } });
		expect(res.status).toBe(404);
	});

	it("409s for a user who exists but hasn't published keys yet", async () => {
		const aliceCookie = await signup('alice_keys_3');
		await signup('grace_keys');

		const res = await SELF.fetch(`${BASE}/api/keys/bundle/grace_keys`, { headers: { Cookie: aliceCookie } });
		expect(res.status).toBe(409);
	});

	it('rejects publish and bundle-fetch without authentication', async () => {
		const publishRes = await SELF.fetch(`${BASE}/api/keys/publish`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...fakeIdentity('nobody'), oneTimePreKeys: [] }),
		});
		expect(publishRes.status).toBe(401);

		const bundleRes = await SELF.fetch(`${BASE}/api/keys/bundle/bob_keys`);
		expect(bundleRes.status).toBe(401);
	});

	it('rate-limits bundle lookups per requester with a 429 once the window budget is spent', async () => {
		const requesterCookie = await signup('enumerator_keys');

		// Fire well past the 30/window limit at a nonexistent target (404s
		// still count — the limiter runs before the existence check, so it
		// throttles enumeration regardless of hit/miss). Expect some 429s.
		//
		// The count is 2*LIMIT+2, not a round 40, because the window is wall-clock
		// (floor(now/60)) and the loop can straddle a boundary. With 40 requests a
		// rollover halfway through splits them ~20/20, neither window exceeds 30,
		// and the test fails with "expected 0 to be greater than 0" — which it did,
		// about one run in twenty. At 2*LIMIT+2 the worst-case split still leaves
		// one window over budget wherever the boundary falls.
		const statuses: number[] = [];
		for (let i = 0; i < 62; i++) {
			const res = await SELF.fetch(`${BASE}/api/keys/bundle/target_${i}_keys`, { headers: { Cookie: requesterCookie } });
			statuses.push(res.status);
		}

		// First lookups succeed (404 for the missing target), later ones are limited.
		expect(statuses[0]).toBe(404);
		expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);

		// A different requester has an independent budget — not limited by the
		// first requester's spending.
		const freshCookie = await signup('fresh_requester_keys');
		const freshRes = await SELF.fetch(`${BASE}/api/keys/bundle/target_0_keys`, { headers: { Cookie: freshCookie } });
		expect(freshRes.status).toBe(404); // 404, not 429 — independent window
	});
});

describe('one-time prekey publish cap (L5)', () => {
	it('rejects an oversized oneTimePreKeys array (>200) with 400', async () => {
		const cookie = await signup('otp_flood');
		const res = await SELF.fetch(`${BASE}/api/keys/publish`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ ...fakeIdentity('otp_flood'), oneTimePreKeys: Array.from({ length: 201 }, (_, i) => 'opk-' + i) }),
		});
		expect(res.status).toBe(400);
	});
});

describe('one-time-prekey exhaustion guard (M2)', () => {
	const pool = async (u: string) =>
		(await env.DB.prepare('SELECT COUNT(*) AS n FROM one_time_prekeys WHERE username = ?').bind(u).first<{ n: number }>())?.n;

	it('a single requester consumes at most one OTP per target per window; repeats fall back to no-OTP', async () => {
		const victim = await signup('otp_victim');
		const asker = await signup('otp_asker');
		await SELF.fetch(`${BASE}/api/keys/publish`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: victim },
			body: JSON.stringify({ ...fakeIdentity('otp_victim'), oneTimePreKeys: ['v-opk-1', 'v-opk-2', 'v-opk-3'] }),
		});
		expect(await pool('otp_victim')).toBe(3);

		const b1 = (await (await SELF.fetch(`${BASE}/api/keys/bundle/otp_victim`, { headers: { Cookie: asker } })).json()) as { oneTimePreKey: string | null };
		expect(typeof b1.oneTimePreKey).toBe('string'); // first lookup: gets an OTP
		expect(await pool('otp_victim')).toBe(2);

		const b2 = (await (await SELF.fetch(`${BASE}/api/keys/bundle/otp_victim`, { headers: { Cookie: asker } })).json()) as { oneTimePreKey: string | null; identityPubkey: unknown; signedPrekey: unknown };
		expect(b2.oneTimePreKey).toBeNull(); // repeat in window: no fresh OTP consumed
		expect(await pool('otp_victim')).toBe(2); // pool NOT drained further
		// bundle is still usable (identity + signed prekey) -> first contact works with no OTP
		expect(b2.identityPubkey).toBeTruthy();
		expect(b2.signedPrekey).toBeTruthy();
	});
});
