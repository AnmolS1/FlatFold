// Sealed-sender wrapper (increment 6) + the MANDATORY two-hop discriminating
// check: the identifier the receipt references (`rid`) must NOT appear on the
// forward hop's gateway-visible bytes, and the forward wire id (`N`) must NOT
// appear on the reverse hop's — else a same-operator gateway relinks
// sender↔recipient and the whole feature is a privacy regression.
import { describe, expect, it } from 'vitest';
import { generateIdentityKeyPair, generateSignedPreKey, initiateX3DH, respondX3DH } from '../crypto/x3dh';
import { initRatchetAsInitiator, initRatchetAsResponder, ratchetDecrypt, ratchetEncrypt } from '../crypto/doubleRatchet';
import { bytesToBase64 } from '../keystore/codec';
import { encodeChatPayload, decodeChatPayload, type ChatPayload } from './chatPayload';
// sealedEnvelopeFromSend is the REAL forward-envelope construction (routing
// through it, not a hand-built shape, catches a future leak added there).
import { sealedEnvelopeFromSend } from './messaging';
import { generateSealToken } from './sealToken';
import { deliveredReceiptEnvelope, NO_SEAL_TOKEN, unwrapSealed, wrapSealed } from './sealedWrap';

const utf8 = new TextEncoder();

describe('sealed-sender wrapper codec', () => {
	it('round-trips su / st / rid / payload bytes', () => {
		const st = generateSealToken();
		const rid = generateSealToken();
		const p = encodeChatPayload({ t: 'text', text: 'hello' });
		const un = unwrapSealed(wrapSealed('alice_sender', st, rid, p));
		expect(un).not.toBeNull();
		expect(un!.su).toBe('alice_sender');
		expect(un!.st).toBe(st);
		expect(un!.rid).toBe(rid);
		expect(decodeChatPayload(un!.p)).toEqual({ t: 'text', text: 'hello' });
	});

	it('round-trips a max-length (32-char) username', () => {
		const su = 'a'.repeat(32);
		const un = unwrapSealed(wrapSealed(su, generateSealToken(), generateSealToken(), encodeChatPayload({ t: 'text', text: 'x' })));
		expect(un!.su).toBe(su);
	});

	it('returns null for a legacy/unwrapped frame (bare encodeChatPayload) — degrades as before', () => {
		// A real encoded payload starts with a 0x00 length byte, never the magic.
		const bare = encodeChatPayload({ t: 'text', text: 'legacy' });
		expect(bare[0]).toBe(0x00);
		expect(unwrapSealed(bare)).toBeNull();
	});

	it('returns null for junk / too-short input', () => {
		expect(unwrapSealed(new Uint8Array([0x01, 0x02]))).toBeNull();
		expect(unwrapSealed(new Uint8Array(0))).toBeNull();
	});

	it('tolerates a missing own-token / empty username by writing sentinels (never throws)', () => {
		const rid = generateSealToken();
		const un = unwrapSealed(wrapSealed('', '', rid, utf8.encode('x')));
		expect(un!.su).toBe(''); // ongoing/no-first-contact → empty claimed username
		expect(un!.st).toBe(NO_SEAL_TOKEN); // recipient will send no receipt for this
		expect(un!.rid).toBe(rid);
	});

	it('deliveredReceiptEnvelope carries rid + a fresh id, and NO identity/messageId', () => {
		const rid = generateSealToken();
		const env = deliveredReceiptEnvelope(rid);
		expect(env.type).toBe('delivered');
		expect(env.rid).toBe(rid);
		expect(env.id).toBeTruthy();
		expect(env.from).toBeUndefined();
		expect(env.messageId).toBeUndefined();
	});
});

function setupSession() {
	const alice = generateIdentityKeyPair();
	const bob = generateIdentityKeyPair();
	const bobSpk = generateSignedPreKey(bob);
	const init = initiateX3DH({
		initiatorIdentity: alice,
		responderIdentity: { signingPublicKey: bob.signing.publicKey, dhPublicKey: bob.dh.publicKey },
		responderSignedPreKey: { publicKey: bobSpk.keyPair.publicKey, signature: bobSpk.signature },
	});
	const resp = respondX3DH({
		responderIdentity: bob,
		responderSignedPreKey: bobSpk,
		initiatorIdentityDhPublicKey: alice.dh.publicKey,
		initiatorEphemeralPublicKey: init.ephemeralPublicKey,
	});
	return {
		alice: initRatchetAsInitiator(init.sharedSecret, bobSpk.keyPair.publicKey),
		bob: initRatchetAsResponder(resp.sharedSecret, bobSpk.keyPair),
		ad: init.associatedData,
	};
}

describe('sealed-sender two-hop unlinkability (MANDATORY discriminating check)', () => {
	it('rid is invisible on the forward hop, and the forward wire id is absent on the reverse hop', () => {
		const { alice, bob, ad } = setupSession();
		const tokenA = generateSealToken(); // Alice's OWN token (rides the wrapper)
		const tokenB = generateSealToken(); // Bob's delivery token (forward hop target)
		const rid = generateSealToken();
		const N = 'wire-id-N'; // the forward message's top-level wire id

		// --- FORWARD hop: A → gateway → B. rid is sealed inside the ciphertext. ---
		const payload: ChatPayload = { t: 'text', text: 'top secret' };
		const { encryptedHeader, ciphertext } = ratchetEncrypt(alice, wrapSealed('alice', tokenA, rid, encodeChatPayload(payload)), ad);
		// Route the forward envelope through the REAL sealedEnvelopeFromSend, then
		// wrap it as apiSealedSend does: {op, recipient, token, envelope} — exactly
		// what handleSeal decapsulates. rid must not leak through any cleartext field.
		const sendFrame = {
			type: 'send' as const,
			id: N,
			to: 'bob',
			ciphertext: bytesToBase64(ciphertext),
			header: { encryptedHeader: bytesToBase64(encryptedHeader) },
		};
		const forwardInner = { op: 'send', recipient: 'bob', token: tokenB, envelope: sealedEnvelopeFromSend(sendFrame) };
		const forwardSeen = JSON.stringify(forwardInner);
		expect(forwardSeen).not.toContain(rid); // ← rid is encrypted, gateway can't see it
		expect(forwardSeen).toContain(N); // the wire id IS visible on the forward hop

		// --- Bob decrypts, recovers st+rid from the wrapper. ---
		const plaintext = ratchetDecrypt(bob, encryptedHeader, ciphertext, ad);
		const un = unwrapSealed(plaintext);
		expect(un).not.toBeNull();
		expect(un!.st).toBe(tokenA);
		expect(un!.rid).toBe(rid);
		expect(decodeChatPayload(un!.p)).toEqual(payload);

		// --- REVERSE hop: B → gateway → A. References rid, a fresh id, nothing else. ---
		const reverseInner = {
			op: 'send',
			recipient: 'alice',
			token: un!.st, // Alice's own token, fresh from the wrapper
			envelope: deliveredReceiptEnvelope(un!.rid),
		};
		const reverseSeen = JSON.stringify(reverseInner);
		expect(reverseSeen).not.toContain(N); // ← forward wire id absent on the reverse hop
		expect(reverseSeen).toContain(rid); // rid IS the reference here (encrypted forward, cleartext now)

		// --- No identifier appears on BOTH hops. ---
		expect(forwardSeen).not.toContain(rid);
		expect(reverseSeen).not.toContain(N);
		expect(tokenA).not.toBe(tokenB); // different tokens per direction
		expect(forwardInner.recipient).not.toBe(reverseInner.recipient); // different routing targets
	});
});
