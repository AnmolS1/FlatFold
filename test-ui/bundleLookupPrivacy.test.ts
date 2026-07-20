// Audit §2: pins the lookup ORDER that the one-time-prekey residual rests on.
//
// THREAT_MODEL.md documents OTP exhaustion as an accepted residual, and the
// whole argument is: the anonymous sealed lookup is tried FIRST and consumes no
// one-time prekey (worker/keys.ts `lookupBundleForSeal` hardcodes
// `oneTimePreKey: null`), so no-OTP X3DH is already the default rather than a
// degraded state an attacker can force us into.
//
// That argument is only true while the ordering holds. Reorder `lookupBundle`
// to prefer the authenticated fetch and two things break at once: the server
// learns who you're about to contact (defeating first-contact sealing), and an
// OTP is consumed on every first contact — which makes the documented residual
// silently false. Nothing asserted this before; lazySession.test.ts mocked the
// authenticated fetch but never checked whether it was called.
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

/**
 * A published bundle as the server would return it. `oneTimePreKey` is a
 * parameter because the two paths differ precisely there: the anonymous path
 * can only ever return null, the authenticated one may return a real key.
 */
function bundleFor(peer: ReturnType<typeof generateIdentityKeyPair>, oneTimePreKey: string | null = null): PreKeyBundleResponse {
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
		oneTimePreKey,
		sealToken: null,
	} as PreKeyBundleResponse;
}

let me: string;

beforeEach(async () => {
	vi.clearAllMocks();
	me = `alice_${Math.floor(performance.now() * 1000)}`;
	await keystore.createIdentity(me, 'correcthorsebattery');
	fetchBundleAnonymous.mockResolvedValue({ status: 'ok', bundle: bundleFor(generateIdentityKeyPair()) });
});

describe('bundle lookup prefers the anonymous path', () => {
	it('never touches the authenticated fetch when the sealed lookup succeeds', async () => {
		await ensureContact(me, 'bob');

		expect(fetchBundleAnonymous).toHaveBeenCalledWith('bob');
		// The load-bearing assertion: the authenticated endpoint is the only one
		// that consumes an OTP, and it was not reached.
		expect(fetchBundleAuthed).not.toHaveBeenCalled();
	});

	it('establishes a session without the authenticated fetch either', async () => {
		// ensureSession has its own lookup call site, so it needs its own guard —
		// this is the one that runs on every first send.
		await ensureSession(me, 'bob');

		expect(await keystore.hasSession(me, 'bob')).toBe(true);
		expect(fetchBundleAuthed).not.toHaveBeenCalled();
	});

	it('treats a clean not-found as final rather than retrying authenticated', async () => {
		// A sealed "not found" is deliberately ambiguous between "no such user"
		// and "hasn't published keys". Retrying over the authenticated endpoint
		// would resolve that ambiguity for the server and hand it the username —
		// exactly what the anonymous lookup exists to prevent.
		fetchBundleAnonymous.mockResolvedValue({ status: 'not-found' });

		expect((await ensureContact(me, 'ghost')).status).toBe('not-found');
		expect(fetchBundleAuthed).not.toHaveBeenCalled();
	});

	it('falls back to the authenticated fetch only when the sealed path errors', async () => {
		// The documented degraded path: a transport/decrypt failure means the
		// relay is unreachable, and reachability beats privacy here. Pinned so the
		// fallback is not mistaken for dead code and deleted — without it, a relay
		// outage would make first contact impossible rather than merely less
		// private.
		fetchBundleAnonymous.mockResolvedValue({ status: 'error' });
		fetchBundleAuthed.mockResolvedValue({ status: 'ok', bundle: bundleFor(generateIdentityKeyPair()) });

		expect((await ensureContact(me, 'bob')).status).toBe('ok');
		expect(fetchBundleAuthed).toHaveBeenCalledWith('bob');
	});
});
