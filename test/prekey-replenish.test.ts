// One-time-prekey replenishment (FULL_AUDIT §2 follow-up).
//
// The bug this closes: each account published exactly 20 one-time prekeys ONCE,
// at identity creation, the server deletes each on use, and nothing ever topped
// the pool back up. So after 20 first-contacts — ordinary use, not an attack —
// the pool was empty permanently and every later contact silently fell back to
// no-OTP X3DH (weaker first-message forward secrecy).
//
// Note the audit's suggested fix (a "last-resort prekey") was NOT implemented:
// a reusable prekey is shared across initiators and never deleted, which leaves
// it in the same forward-secrecy position as no-OTP X3DH. Replenishment is what
// actually restores the property.
import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

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

async function publish(cookie: string, seed: string, oneTimePreKeys: string[]): Promise<Response> {
	return SELF.fetch(`${BASE}/api/keys/publish`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Cookie: cookie },
		body: JSON.stringify({
			identityPubkey: { signingPublicKey: `sign-${seed}`, dhPublicKey: `dh-${seed}` },
			signedPrekey: { publicKey: `spk-${seed}`, signature: `sig-${seed}` },
			oneTimePreKeys,
		}),
	});
}

async function remaining(cookie: string): Promise<number> {
	const res = await SELF.fetch(`${BASE}/api/keys/prekeys`, { headers: { Cookie: cookie } });
	expect(res.status).toBe(200);
	return ((await res.json()) as { remaining: number }).remaining;
}

async function addPrekeys(cookie: string, keys: string[]): Promise<Response> {
	return SELF.fetch(`${BASE}/api/keys/prekeys`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Cookie: cookie },
		body: JSON.stringify({ oneTimePreKeys: keys }),
	});
}

describe('one-time prekey replenishment', () => {
	it('reports how many prekeys are left', async () => {
		const cookie = await signup('rp_count');
		await publish(cookie, 'rp_count', ['opk-a', 'opk-b', 'opk-c']);
		expect(await remaining(cookie)).toBe(3);
	});

	it('the count drops as bundle fetches consume prekeys', async () => {
		const bob = await signup('rp_bob');
		await publish(bob, 'rp_bob', ['opk-1', 'opk-2']);
		expect(await remaining(bob)).toBe(2);

		const alice = await signup('rp_alice');
		const res = await SELF.fetch(`${BASE}/api/keys/bundle/rp_bob`, { headers: { Cookie: alice } });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { oneTimePreKey: string | null }).oneTimePreKey).toBeTruthy();

		expect(await remaining(bob)).toBe(1);
	});

	it('tops the pool back up without disturbing the identity or signed prekey', async () => {
		const cookie = await signup('rp_top');
		await publish(cookie, 'rp_top', ['opk-x']);
		expect(await remaining(cookie)).toBe(1);

		const res = await addPrekeys(cookie, ['opk-y', 'opk-z']);
		expect(res.status).toBe(200);
		expect(await remaining(cookie)).toBe(3);

		// The identity + signed prekey a peer fetches must be untouched by a top-up:
		// republishing identity material would be a silent key change for contacts.
		const alice = await signup('rp_top_peer');
		const bundle = (await (
			await SELF.fetch(`${BASE}/api/keys/bundle/rp_top`, { headers: { Cookie: alice } })
		).json()) as { identityPubkey: { dhPublicKey: string }; signedPrekey: { publicKey: string } };
		expect(bundle.identityPubkey.dhPublicKey).toBe('dh-rp_top');
		expect(bundle.signedPrekey.publicKey).toBe('spk-rp_top');
	});

	it('caps the stored pool so replenishment cannot grow without bound', async () => {
		const cookie = await signup('rp_cap');
		await publish(cookie, 'rp_cap', []);
		// Push far more than any sane client would, in batches.
		for (let i = 0; i < 4; i++) {
			await addPrekeys(
				cookie,
				Array.from({ length: 60 }, (_, n) => `opk-cap-${i}-${n}`)
			);
		}
		const left = await remaining(cookie);
		expect(left).toBeGreaterThan(0);
		expect(left).toBeLessThanOrEqual(100); // MAX_STORED_ONE_TIME_PREKEYS
	});

	it('rejects an unauthenticated count or top-up', async () => {
		const countRes = await SELF.fetch(`${BASE}/api/keys/prekeys`);
		expect(countRes.status).toBe(401);
		const addRes = await SELF.fetch(`${BASE}/api/keys/prekeys`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ oneTimePreKeys: ['nope'] }),
		});
		expect(addRes.status).toBe(401);
	});

	it('rejects malformed top-up payloads', async () => {
		const cookie = await signup('rp_bad');
		const res = await addPrekeys(cookie, [123 as unknown as string]);
		expect(res.status).toBe(400);
	});
});
