import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { Aes128Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import type { WsMessageFrame } from '../shared/types';
import { openResponse, SEALED_RESPONSE_EXPORT_LABEL, SEALED_RESPONSE_EXPORT_LENGTH } from '../shared/sealedResponse';

const BASE = 'https://example.com';
const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
const EXPORT_LABEL = new TextEncoder().encode(SEALED_RESPONSE_EXPORT_LABEL);
const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function signup(username: string): Promise<string> {
	const res = await SELF.fetch(`${BASE}/api/auth/signup`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password: 'correcthorsebattery' }),
	});
	const cookie = res.headers.get('Set-Cookie')?.split(';')[0];
	if (!cookie) throw new Error('no cookie');
	return cookie;
}

async function registerToken(cookie: string, token: string): Promise<Response> {
	return SELF.fetch(`${BASE}/api/seal/register-token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Cookie: cookie },
		body: JSON.stringify({ token }),
	});
}

async function dbSealToken(username: string): Promise<string | null> {
	const row = await env.DB.prepare('SELECT seal_token FROM users WHERE username = ?').bind(username).first<{ seal_token: string | null }>();
	return row?.seal_token ?? null;
}

async function doTokens(username: string): Promise<string[]> {
	const stub = env.MAILBOX.getByName(username);
	return (await runInDurableObject(stub, (_i, state) => state.storage.get<string[]>('sealTokens'))) ?? [];
}

// A sealed send exactly as a client would build it: HPKE-encapsulate
// {recipient, token, envelope} to the gateway's published key. Note the body
// carries NO sender identity — that's the whole point.
async function sealedSend(recipient: string, token: string, envelope: unknown, headers?: Record<string, string>): Promise<Response> {
	const cfg = (await (await SELF.fetch(`${BASE}/api/seal/keys`)).json()) as { publicKey: string };
	const pub = await suite.kem.deserializePublicKey(b64ToBytes(cfg.publicKey).buffer);
	const sender = await suite.createSenderContext({ recipientPublicKey: pub });
	const inner = new TextEncoder().encode(JSON.stringify({ recipient, token, envelope }));
	const ct = new Uint8Array(await sender.seal(inner.buffer));
	const enc = new Uint8Array(sender.enc);
	const body = new Uint8Array(enc.length + ct.length);
	body.set(enc, 0);
	body.set(ct, enc.length);
	return SELF.fetch(`${BASE}/api/seal`, { method: 'POST', body, headers });
}

async function publishKeys(cookie: string, seed: string, oneTimePreKeys: string[]): Promise<void> {
	await SELF.fetch(`${BASE}/api/keys/publish`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Cookie: cookie },
		body: JSON.stringify({
			identityPubkey: { signingPublicKey: `sign-${seed}`, dhPublicKey: `dh-${seed}` },
			signedPrekey: { publicKey: `spk-${seed}`, signature: `sig-${seed}` },
			oneTimePreKeys,
		}),
	});
}

// An anonymous bundle fetch exactly as the client builds it: HPKE-encapsulate
// {op:'fetchBundle', contact} to the gateway, POST with NO cookie, then open the
// sealed response with the shared exporter-secret AEAD. Returns the raw blob (to
// assert length uniformity) plus a decoder.
async function sealedFetchBundle(contact: string): Promise<{ blob: Uint8Array; open: () => Promise<Record<string, unknown>> }> {
	const cfg = (await (await SELF.fetch(`${BASE}/api/seal/keys`)).json()) as { publicKey: string };
	const pub = await suite.kem.deserializePublicKey(b64ToBytes(cfg.publicKey).buffer);
	const sender = await suite.createSenderContext({ recipientPublicKey: pub });
	const inner = new TextEncoder().encode(JSON.stringify({ op: 'fetchBundle', contact }));
	const ct = new Uint8Array(await sender.seal(inner.buffer));
	const enc = new Uint8Array(sender.enc);
	const body = new Uint8Array(enc.length + ct.length);
	body.set(enc, 0);
	body.set(ct, enc.length);
	const res = await SELF.fetch(`${BASE}/api/seal`, { method: 'POST', body });
	const blob = new Uint8Array(await res.arrayBuffer());
	const secret = new Uint8Array(await sender.export(EXPORT_LABEL, SEALED_RESPONSE_EXPORT_LENGTH));
	return { blob, open: async () => JSON.parse(new TextDecoder().decode(await openResponse(secret, enc, blob))) as Record<string, unknown> };
}

const ENVELOPE = { type: 'message', id: 'sm1', ciphertext: 'x', header: { encryptedHeader: 'x' }, ts: 0 };

describe('sealed-sender gateway (increment 1)', () => {
	it('publishes the gateway HPKE key config', async () => {
		const cfg = (await (await SELF.fetch(`${BASE}/api/seal/keys`)).json()) as { publicKey: string; kem: string };
		expect(cfg.publicKey).toBeTruthy();
		expect(cfg.kem).toContain('P-256');
	});

	it('delivers a sealed send with a valid token — and the envelope carries no sender', async () => {
		const cookie = await signup('seal_bob');
		const token = 'tok_' + 'b'.repeat(24);
		await registerToken(cookie, token);

		const res = await sealedSend('seal_bob', token, ENVELOPE);
		expect(res.status).toBe(202);

		// Bob is offline (no socket) → queued in his DO under a receive-order key.
		const stub = env.MAILBOX.getByName('seal_bob');
		const stored = await runInDurableObject(stub, (_i, state) => state.storage.list({ prefix: 'envelope:' }));
		expect(stored.size).toBe(1);
		const env0 = [...stored.values()][0] as Record<string, unknown>;
		expect(env0.id).toBe('sm1');
		expect('from' in env0).toBe(false); // no sender identity anywhere
	});

	it('rejects an invalid token (not delivered) but returns a UNIFORM 202 (no oracle)', async () => {
		const cookie = await signup('seal_carol');
		await registerToken(cookie, 'tok_' + 'c'.repeat(24));

		const res = await sealedSend('seal_carol', 'tok_WRONG' + 'x'.repeat(16), ENVELOPE);
		expect(res.status).toBe(202); // same status as success — can't probe validity

		const stub = env.MAILBOX.getByName('seal_carol');
		const stored = await runInDurableObject(stub, (_i, state) => state.storage.list({ prefix: 'envelope:' }));
		expect(stored.size).toBe(0); // nothing delivered
	});

	it('garbage / undecryptable body returns a uniform 202 without error detail', async () => {
		const res = await SELF.fetch(`${BASE}/api/seal`, { method: 'POST', body: new Uint8Array([1, 2, 3, 4, 5]) });
		expect(res.status).toBe(202);
	});

	it('a from-less ack deletes the queued sealed copy with no reverse hop (else it redelivers forever)', async () => {
		const cookie = await signup('ack_liam');
		const token = 'tok_' + 'l'.repeat(24);
		await registerToken(cookie, token);

		// Recipient offline → the sealed send queues under recvSeq.
		await sealedSend('ack_liam', token, { ...ENVELOPE, id: 'sealed-ack-1' });
		const stub = env.MAILBOX.getByName('ack_liam');
		expect((await runInDurableObject(stub, (_i, state) => state.storage.list({ prefix: 'envelope:' }))).size).toBe(1);

		// Recipient connects; the queued from-less envelope flushes to the socket.
		const wsRes = await SELF.fetch(`${BASE}/ws`, { headers: { Upgrade: 'websocket', Cookie: cookie } });
		const ws = wsRes.webSocket!;
		ws.accept();
		const flushed = await new Promise<WsMessageFrame>((res) =>
			ws.addEventListener('message', (e) => res(JSON.parse((e as MessageEvent).data as string) as WsMessageFrame), { once: true })
		);
		expect(flushed.id).toBe('sealed-ack-1');
		expect('from' in flushed).toBe(false); // delivered from-less

		// Ack with NO `to` (we don't know the sender) — deletes our own copy only.
		ws.send(JSON.stringify({ type: 'ack', messageId: 'sealed-ack-1' }));
		await vi.waitFor(async () => {
			const left = await runInDurableObject(stub, (_i, state) => state.storage.list({ prefix: 'envelope:' }));
			expect(left.size).toBe(0);
		});
	});
});

describe('sealed first-contact (increment 7)', () => {
	it('forwards a first-contact envelope through the gateway opaquely: x3dhSealed intact, still from-less', async () => {
		const cookie = await signup('fc_nina');
		const token = 'tok_' + 'n'.repeat(24);
		await registerToken(cookie, token);

		// A first-contact envelope carries the handshake ECIES-sealed in x3dhSealed —
		// the gateway forwards it as opaque bytes; it never sees a sender identity.
		const envelope = { type: 'message', id: 'fc1', ciphertext: 'x', header: { encryptedHeader: 'x' }, ts: 0, x3dhSealed: 'ZmFrZS1zZWFsZWQtaGFuZHNoYWtl' };
		const res = await sealedSend('fc_nina', token, envelope);
		expect(res.status).toBe(202);

		const stub = env.MAILBOX.getByName('fc_nina');
		const stored = await runInDurableObject(stub, (_i, state) => state.storage.list({ prefix: 'envelope:' }));
		expect(stored.size).toBe(1);
		const env0 = [...stored.values()][0] as Record<string, unknown>;
		expect(env0.x3dhSealed).toBe('ZmFrZS1zZWFsZWQtaGFuZHNoYWtl'); // forwarded verbatim
		expect('from' in env0).toBe(false); // no sender identity
		expect('x3dh' in env0).toBe(false); // no cleartext handshake either
	});
});

describe('sealed delivered-receipt (increment 6)', () => {
	it('queues a from-less delivered-receipt (referencing rid, no identity) and an ack clears it', async () => {
		// The SENDER registers its own token; the recipient reaches it over the
		// sealed path with a delivered-receipt using that (fresh-from-wrapper) token.
		const cookie = await signup('rcpt_sender');
		const senderToken = 'tok_' + 's'.repeat(24);
		await registerToken(cookie, senderToken);

		const receipt = { type: 'delivered', id: 'rcpt-1', rid: 'rid-abc123' };
		const res = await sealedSend('rcpt_sender', senderToken, receipt);
		expect(res.status).toBe(202);

		// Sender offline → the receipt QUEUES (not live-only) so a briefly-offline
		// sender still learns delivery on reconnect.
		const stub = env.MAILBOX.getByName('rcpt_sender');
		const stored = await runInDurableObject(stub, (_i, state) => state.storage.list({ prefix: 'envelope:' }));
		expect(stored.size).toBe(1);
		const env0 = [...stored.values()][0] as Record<string, unknown>;
		expect(env0.type).toBe('delivered');
		expect(env0.rid).toBe('rid-abc123');
		expect('from' in env0).toBe(false); // no acker identity
		expect('messageId' in env0).toBe(false); // never the original wire id

		// Sender connects; the queued receipt flushes, then the sender acks it
		// (messageId = the receipt's fresh id, no `to`) to clear its own copy so it
		// doesn't re-flush every reconnect.
		const wsRes = await SELF.fetch(`${BASE}/ws`, { headers: { Upgrade: 'websocket', Cookie: cookie } });
		const ws = wsRes.webSocket!;
		ws.accept();
		const flushed = await new Promise<Record<string, unknown>>((resolve) =>
			ws.addEventListener('message', (e) => resolve(JSON.parse((e as MessageEvent).data as string) as Record<string, unknown>), { once: true })
		);
		expect(flushed.type).toBe('delivered');
		expect(flushed.rid).toBe('rid-abc123');

		ws.send(JSON.stringify({ type: 'ack', messageId: 'rcpt-1' }));
		await vi.waitFor(async () => {
			const left = await runInDurableObject(stub, (_i, state) => state.storage.list({ prefix: 'envelope:' }));
			expect(left.size).toBe(0);
		});
	});

	it('rejects a delivered-receipt on an invalid token — uniform 202, nothing queued', async () => {
		const cookie = await signup('rcpt_carl');
		await registerToken(cookie, 'tok_' + 'r'.repeat(24));
		const res = await sealedSend('rcpt_carl', 'tok_WRONG' + 'x'.repeat(16), { type: 'delivered', id: 'r2', rid: 'rid-nope' });
		expect(res.status).toBe(202);
		const stub = env.MAILBOX.getByName('rcpt_carl');
		const stored = await runInDurableObject(stub, (_i, state) => state.storage.list({ prefix: 'envelope:' }));
		expect(stored.size).toBe(0);
	});
});

describe('sealed-sender relay-auth enforcement (Tier-2)', () => {
	const HDR = 'X-Seal-Relay-Auth';
	// env.SEAL_RELAY_AUTH is absent by default (not in wrangler vars) ⇒ enforcement
	// OFF. Each test that turns it on restores it after, so it never leaks between
	// tests (which would 403 the many other sealedSend()s in this file).
	async function withRelayAuth(value: string, fn: () => Promise<void>): Promise<void> {
		const prev = (env as { SEAL_RELAY_AUTH?: string }).SEAL_RELAY_AUTH;
		(env as { SEAL_RELAY_AUTH?: string }).SEAL_RELAY_AUTH = value;
		try {
			await fn();
		} finally {
			(env as { SEAL_RELAY_AUTH?: string }).SEAL_RELAY_AUTH = prev;
		}
	}

	it('when the secret is unset, a send with no header is still accepted (dev/back-compat)', async () => {
		const cookie = await signup('auth_off');
		const token = 'tok_' + 'o'.repeat(24);
		await registerToken(cookie, token);
		const res = await sealedSend('auth_off', token, ENVELOPE); // no header
		expect(res.status).toBe(202);
	});

	it('when the secret is set, a send with the matching header is processed and delivered', async () => {
		await withRelayAuth('relay-secret-A', async () => {
			const cookie = await signup('auth_ok');
			const token = 'tok_' + 'k'.repeat(24);
			await registerToken(cookie, token);
			const res = await sealedSend('auth_ok', token, { ...ENVELOPE, id: 'auth-ok-1' }, { [HDR]: 'relay-secret-A' });
			expect(res.status).toBe(202);
			const stub = env.MAILBOX.getByName('auth_ok');
			const stored = await runInDurableObject(stub, (_i, state) => state.storage.list({ prefix: 'envelope:' }));
			expect(stored.size).toBe(1);
		});
	});

	it('when the secret is set, a send with a MISSING header is 403 (nothing delivered)', async () => {
		await withRelayAuth('relay-secret-A', async () => {
			const cookie = await signup('auth_missing');
			const token = 'tok_' + 'm'.repeat(24);
			await registerToken(cookie, token);
			const res = await sealedSend('auth_missing', token, ENVELOPE); // no header
			expect(res.status).toBe(403);
			const stub = env.MAILBOX.getByName('auth_missing');
			const stored = await runInDurableObject(stub, (_i, state) => state.storage.list({ prefix: 'envelope:' }));
			expect(stored.size).toBe(0);
		});
	});

	it('when the secret is set, a send with a WRONG header is 403', async () => {
		await withRelayAuth('relay-secret-A', async () => {
			const cookie = await signup('auth_wrong');
			const token = 'tok_' + 'w'.repeat(24);
			await registerToken(cookie, token);
			const res = await sealedSend('auth_wrong', token, ENVELOPE, { [HDR]: 'not-the-secret' });
			expect(res.status).toBe(403);
		});
	});

	it('accepts EITHER secret from a comma-separated allow-list (rotation window)', async () => {
		await withRelayAuth('old-secret , new-secret', async () => {
			const cookie = await signup('auth_rot');
			const token = 'tok_' + 'r'.repeat(24);
			await registerToken(cookie, token);
			// whitespace around list entries is trimmed
			expect((await sealedSend('auth_rot', token, { ...ENVELOPE, id: 'rot-old' }, { [HDR]: 'old-secret' })).status).toBe(202);
			expect((await sealedSend('auth_rot', token, { ...ENVELOPE, id: 'rot-new' }, { [HDR]: 'new-secret' })).status).toBe(202);
			expect((await sealedSend('auth_rot', token, ENVELOPE, { [HDR]: 'evicted-secret' })).status).toBe(403);
		});
	});

	it('the key-config GET stays public even when the secret is set (clients fetch it directly)', async () => {
		await withRelayAuth('relay-secret-A', async () => {
			const res = await SELF.fetch(`${BASE}/api/seal/keys`);
			expect(res.status).toBe(200);
			expect(((await res.json()) as { publicKey: string }).publicKey).toBeTruthy();
		});
	});

	it('register-token (authenticated, same-origin) is unaffected by relay-auth', async () => {
		await withRelayAuth('relay-secret-A', async () => {
			const cookie = await signup('auth_reg');
			const res = await registerToken(cookie, 'tok_' + 'g'.repeat(24)); // no relay header
			expect(res.ok).toBe(true);
		});
	});
});

describe('sealed-sender delivery tokens (increment 2)', () => {
	it('register-token writes BOTH the DO validator set and the D1 bundle copy', async () => {
		const cookie = await signup('tok_dave');
		const token = 'tok_' + 'd'.repeat(24);
		const res = await registerToken(cookie, token);
		expect(res.ok).toBe(true);
		expect(await doTokens('tok_dave')).toEqual([token]); // DO validator
		expect(await dbSealToken('tok_dave')).toBe(token); // D1 bundle copy — served to first-contacters
	});

	it('rejects a too-short token with 400 and leaves both stores untouched', async () => {
		const cookie = await signup('tok_erin');
		const res = await registerToken(cookie, 'short');
		expect(res.status).toBe(400);
		expect(await doTokens('tok_erin')).toEqual([]);
		expect(await dbSealToken('tok_erin')).toBeNull();
	});

	it('keeps only the newest 3 tokens (rotation grace); an evicted token no longer delivers', async () => {
		const cookie = await signup('tok_frank');
		const tokens = [0, 1, 2, 3].map((i) => `tok_${'f'.repeat(20)}_${i}`);
		for (const t of tokens) await registerToken(cookie, t); // oldest → newest

		// The DO caps at 3, newest-first — the oldest (tokens[0]) is evicted.
		expect(await doTokens('tok_frank')).toEqual([tokens[3], tokens[2], tokens[1]]);
		// D1 reflects the latest published token.
		expect(await dbSealToken('tok_frank')).toBe(tokens[3]);

		// A send with the evicted token is rejected (queued nothing)...
		await sealedSend('tok_frank', tokens[0], ENVELOPE);
		const stub = env.MAILBOX.getByName('tok_frank');
		let stored = await runInDurableObject(stub, (_i, state) => state.storage.list({ prefix: 'envelope:' }));
		expect(stored.size).toBe(0);

		// ...while a token still in the grace window delivers.
		await sealedSend('tok_frank', tokens[1], ENVELOPE);
		stored = await runInDurableObject(stub, (_i, state) => state.storage.list({ prefix: 'envelope:' }));
		expect(stored.size).toBe(1);
	});
});

describe('sealed-sender anonymous bundle fetch (increment 3)', () => {
	it('returns a peer bundle + delivery token over the sealed response, with no one-time prekey', async () => {
		const cookie = await signup('fetch_grace');
		await publishKeys(cookie, 'grace', ['g-opk-1', 'g-opk-2']);
		const token = 'tok_' + 'g'.repeat(24);
		await SELF.fetch(`${BASE}/api/seal/register-token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ token }),
		});

		const { open } = await sealedFetchBundle('fetch_grace');
		const bundle = await open();
		expect(bundle.identityPubkey).toEqual({ signingPublicKey: 'sign-grace', dhPublicKey: 'dh-grace' });
		expect(bundle.signedPrekey).toEqual({ publicKey: 'spk-grace', signature: 'sig-grace' });
		expect(bundle.sealToken).toBe(token);
		expect(bundle.oneTimePreKey).toBeNull(); // anonymous path never consumes an OPK
	});

	it('does NOT consume one-time prekeys (anti-drain) — the pool is untouched by anonymous fetches', async () => {
		const cookie = await signup('fetch_heidi');
		await publishKeys(cookie, 'heidi', ['h-opk-1', 'h-opk-2', 'h-opk-3']);
		const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM one_time_prekeys WHERE username = ?').bind('fetch_heidi').first<{ n: number }>();

		await sealedFetchBundle('fetch_heidi');
		await sealedFetchBundle('fetch_heidi');
		await sealedFetchBundle('fetch_heidi');

		const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM one_time_prekeys WHERE username = ?').bind('fetch_heidi').first<{ n: number }>();
		expect(after?.n).toBe(before?.n); // still 3 — none drained
	});

	it('returns a length-uniform sealed "not found" for an unknown user (non-oracle)', async () => {
		const cookie = await signup('fetch_ivan');
		await publishKeys(cookie, 'ivan', ['i-opk-1']);

		const real = await sealedFetchBundle('fetch_ivan');
		const missing = await sealedFetchBundle('nobody_at_all_xyz');

		expect((await missing.open()).notFound).toBe(true);
		// The sealed response is byte-length-identical whether the user exists or
		// not — a relay/network observer can't read target-existence off it.
		expect(missing.blob.length).toBe(real.blob.length);
	});

	it('a user who exists but has not published keys is indistinguishable from not-found', async () => {
		await signup('fetch_judy'); // no publishKeys
		const { open } = await sealedFetchBundle('fetch_judy');
		expect((await open()).notFound).toBe(true);
	});

	// LAST in this block: it pre-fills the shared global bucket, which would
	// throttle any fetchBundle test running after it in the same 60s window.
	it('applies a blunt GLOBAL throttle — over the window cap returns no sealed body, even for a real user', async () => {
		const cookie = await signup('fetch_karl');
		await publishKeys(cookie, 'karl', ['k-opk-1']);

		// Saturate the global anonymous-fetch bucket for the current window.
		const windowStart = Math.floor(Date.now() / 1000 / 60) * 60;
		await env.DB.prepare(
			'INSERT INTO rate_limits (requester, window_start, count) VALUES (?, ?, ?) ON CONFLICT(requester, window_start) DO UPDATE SET count = excluded.count'
		)
			.bind('seal:fetchbundle', windowStart, 120)
			.run();

		// Over the cap → uniform empty 202, no sealed body — and it's global, so it
		// never reveals whether this (real) target exists.
		const throttled = await sealedFetchBundle('fetch_karl');
		expect(throttled.blob.length).toBe(0);
	});
});
