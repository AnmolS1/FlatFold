// Option A: session establishment moves from contact-add to first send.
//
// Eagerly building an initiator ratchet at add time is what caused the
// mutual-add collision: if both sides add each other before either sends, both
// hold an initiator session, and the receive path's existing session shadows the
// incoming x3dh so respondX3DH never runs. Deferring session creation to the
// first send means the receiver has nothing to shadow it.
//
// These run against a real (in-memory) IndexedDB, so the keystore is exercised
// for real. Only the network boundary is stubbed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreKeyBundleResponse } from '../shared/types';

const fetchBundleAnonymous = vi.fn();
const fetchBundleAuthed = vi.fn();

vi.mock('../src/lib/sealedFetch', () => ({
	apiFetchBundleAnonymous: (contact: string) => fetchBundleAnonymous(contact),
	apiSealedSend: vi.fn(),
}));
vi.mock('../src/lib/api', () => ({
	apiFetchBundle: (contact: string) => fetchBundleAuthed(contact),
	apiRegisterSealToken: vi.fn(),
}));

const keystore = await import('../src/keystore');
const { ensureContact, ensureSession } = await import('../src/lib/messaging');
const { generateIdentityKeyPair, generateSignedPreKey } = await import('../src/crypto/x3dh');
const { bytesToBase64 } = await import('../src/keystore/codec');

/** A published bundle for a peer, as the server would return it. */
function bundleFor(peer: ReturnType<typeof generateIdentityKeyPair>): PreKeyBundleResponse {
	const spk = generateSignedPreKey(peer);
	return {
		identityPubkey: {
			signingPublicKey: bytesToBase64(peer.signing.publicKey),
			dhPublicKey: bytesToBase64(peer.dh.publicKey),
		},
		signedPrekey: {
			publicKey: bytesToBase64(spk.keyPair.publicKey),
			signature: bytesToBase64(spk.signature),
		},
		oneTimePreKey: null,
		sealToken: null,
	} as PreKeyBundleResponse;
}

let me: string;

beforeEach(async () => {
	vi.clearAllMocks();
	// A fresh account per test — createIdentity leaves the keystore unlocked.
	me = `alice_${Math.floor(performance.now() * 1000)}`;
	await keystore.createIdentity(me, 'correcthorsebattery');
	fetchBundleAnonymous.mockResolvedValue({ status: 'ok', bundle: bundleFor(generateIdentityKeyPair()) });
});

describe('adding a contact does not establish a session', () => {
	it('stores the contact identity but builds no ratchet', async () => {
		const result = await ensureContact(me, 'bob');

		expect(result.status).toBe('ok');
		expect(await keystore.getContact(me, 'bob')).not.toBeNull();
		// The whole point of A: no ratchet state exists yet.
		expect(await keystore.hasSession(me, 'bob')).toBe(false);
	});

	it('reports an unknown user without creating anything', async () => {
		fetchBundleAnonymous.mockResolvedValue({ status: 'not-found' });

		expect((await ensureContact(me, 'nobody')).status).toBe('not-found');
		expect(await keystore.getContact(me, 'nobody')).toBeNull();
		expect(await keystore.hasSession(me, 'nobody')).toBe(false);
	});
});

describe('the first send establishes the session', () => {
	it('creates the ratchet and returns handshake material to ride the message', async () => {
		await ensureContact(me, 'bob');
		expect(await keystore.hasSession(me, 'bob')).toBe(false);

		const result = await ensureSession(me, 'bob');

		expect(result.status).toBe('ok');
		expect(await keystore.hasSession(me, 'bob')).toBe(true);
		// Only the first message of a session carries X3DH material.
		expect(result.status === 'ok' && result.pendingHandshake).not.toBeNull();
	});

	it('is idempotent — a second send reuses the session and sends no handshake', async () => {
		await ensureSession(me, 'bob');
		const second = await ensureSession(me, 'bob');

		expect(second.status === 'ok' && second.pendingHandshake).toBeNull();
	});

	it('works for a contact that was never explicitly added', async () => {
		// ensureSession must still stand alone — the group sender-key and
		// delivery-token paths call it directly for members that may not be 1:1
		// contacts yet.
		const result = await ensureSession(me, 'carol');

		expect(result.status).toBe('ok');
		expect(await keystore.hasSession(me, 'carol')).toBe(true);
		expect(await keystore.getContact(me, 'carol')).not.toBeNull();
	});
});
