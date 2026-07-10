// First-contact sealing (increment 7) — crypto-level end-to-end + adversarial
// metadata. The receive-side BOOTSTRAP in decryptIncoming needs IndexedDB and is
// covered by the live 2-user drive; this proves the underlying mechanism composes
// (sealed handshake → X3DH → ratchet → wrapper) and that the gateway-visible bytes
// leak NO sender identity, without a keystore.
import { describe, expect, it } from 'vitest';
import { generateIdentityKeyPair, generateSignedPreKey, initiateX3DH, respondX3DH } from '../crypto/x3dh';
import { initRatchetAsInitiator, initRatchetAsResponder, ratchetDecrypt, ratchetEncrypt } from '../crypto/doubleRatchet';
import { openBox } from '../crypto/sealedBox';
import { base64ToBytes, bytesToBase64 } from '../keystore/codec';
import { encodeChatPayload, decodeChatPayload, type ChatPayload } from './chatPayload';
import { sealedFirstContactEnvelope } from './messaging';
import { generateSealToken } from './sealToken';
import { wrapSealed, unwrapSealed } from './sealedWrap';
import type { X3dhHandshakeWire } from '../types';

// Build a sealed first-contact message from `initiator` (claiming `claimedName`)
// to `responder`, exactly as the send path does: initiateX3DH, wrap {su,st,rid,p}
// inside the ratchet, then ECIES the handshake to the responder's identity key.
function buildSealedFirstContact(opts: {
	initiator: ReturnType<typeof generateIdentityKeyPair>;
	claimedName: string;
	responderIdentity: ReturnType<typeof generateIdentityKeyPair>;
	responderSpk: ReturnType<typeof generateSignedPreKey>;
	payload: ChatPayload;
	st: string;
	rid: string;
	id: string;
}) {
	const x3dh = initiateX3DH({
		initiatorIdentity: opts.initiator,
		responderIdentity: { signingPublicKey: opts.responderIdentity.signing.publicKey, dhPublicKey: opts.responderIdentity.dh.publicKey },
		responderSignedPreKey: { publicKey: opts.responderSpk.keyPair.publicKey, signature: opts.responderSpk.signature },
	});
	const ratchet = initRatchetAsInitiator(x3dh.sharedSecret, opts.responderSpk.keyPair.publicKey);
	const { encryptedHeader, ciphertext } = ratchetEncrypt(ratchet, wrapSealed(opts.claimedName, opts.st, opts.rid, encodeChatPayload(opts.payload)), x3dh.associatedData);
	const pendingHandshake: X3dhHandshakeWire = {
		initiatorIdentityDhPublicKey: bytesToBase64(opts.initiator.dh.publicKey),
		initiatorIdentitySigningPublicKey: bytesToBase64(opts.initiator.signing.publicKey),
		initiatorEphemeralPublicKey: bytesToBase64(x3dh.ephemeralPublicKey),
	};
	const sendFrame = {
		type: 'send' as const,
		id: opts.id,
		to: opts.claimedName,
		ciphertext: bytesToBase64(ciphertext),
		header: { encryptedHeader: bytesToBase64(encryptedHeader) },
		x3dh: pendingHandshake,
	};
	return sealedFirstContactEnvelope(sendFrame, pendingHandshake, opts.responderIdentity.dh.publicKey);
}

describe('first-contact sealing (increment 7)', () => {
	it('round-trips end-to-end: sealed handshake → X3DH → ratchet → wrapper', () => {
		const bob = generateIdentityKeyPair();
		const alice = generateIdentityKeyPair();
		const aliceSpk = generateSignedPreKey(alice);
		const st = generateSealToken();
		const rid = generateSealToken();
		const payload: ChatPayload = { t: 'text', text: 'hi from bob' };

		const envelope = buildSealedFirstContact({ initiator: bob, claimedName: 'bob', responderIdentity: alice, responderSpk: aliceSpk, payload, st, rid, id: 'N1' });

		// Alice's bootstrap: open the handshake with her identity key.
		const handshakeBytes = openBox(alice.dh.secretKey, base64ToBytes(envelope.x3dhSealed!));
		expect(handshakeBytes).not.toBeNull();
		const handshake = JSON.parse(new TextDecoder().decode(handshakeBytes!)) as X3dhHandshakeWire;
		expect(handshake.initiatorIdentityDhPublicKey).toBe(bytesToBase64(bob.dh.publicKey));

		// Complete X3DH (no OPK) and decrypt.
		const responded = respondX3DH({
			responderIdentity: alice,
			responderSignedPreKey: aliceSpk,
			initiatorIdentityDhPublicKey: base64ToBytes(handshake.initiatorIdentityDhPublicKey),
			initiatorEphemeralPublicKey: base64ToBytes(handshake.initiatorEphemeralPublicKey),
		});
		const ratchet = initRatchetAsResponder(responded.sharedSecret, aliceSpk.keyPair);
		const plaintext = ratchetDecrypt(ratchet, base64ToBytes(envelope.header.encryptedHeader), base64ToBytes(envelope.ciphertext), responded.associatedData);
		const unwrapped = unwrapSealed(plaintext);
		expect(unwrapped!.su).toBe('bob');
		expect(unwrapped!.st).toBe(st);
		expect(decodeChatPayload(unwrapped!.p)).toEqual(payload);
	});

	it('ADVERSARIAL METADATA: the gateway-visible envelope leaks NO sender identity keys', () => {
		const bob = generateIdentityKeyPair();
		const alice = generateIdentityKeyPair();
		const aliceSpk = generateSignedPreKey(alice);

		const envelope = buildSealedFirstContact({ initiator: bob, claimedName: 'bob', responderIdentity: alice, responderSpk: aliceSpk, payload: { t: 'text', text: 'x' }, st: generateSealToken(), rid: generateSealToken(), id: 'N2' });

		// What apiSealedSend HPKE-seals to the gateway (what handleSeal decapsulates).
		const gatewaySees = JSON.stringify({ op: 'send', recipient: 'alice', token: generateSealToken(), envelope });
		// The initiator's long-term identity keys must NOT appear in cleartext — they
		// live only inside x3dhSealed (ECIES to Alice). This is the P1 property.
		expect(gatewaySees).not.toContain(bytesToBase64(bob.dh.publicKey));
		expect(gatewaySees).not.toContain(bytesToBase64(bob.signing.publicKey));
		// No cleartext x3dh field; the opaque handshake blob IS present.
		expect(envelope.x3dh).toBeUndefined();
		expect(envelope.x3dhSealed).toBeTruthy();
	});

	it('ANTI-SPOOF: a spoofer claiming another name presents a DH key that mismatches the real bundle', () => {
		const realBob = generateIdentityKeyPair(); // bob's real published identity
		const spoofer = generateIdentityKeyPair(); // attacker's own keys
		const alice = generateIdentityKeyPair();
		const aliceSpk = generateSignedPreKey(alice);

		// The spoofer runs the whole flow with THEIR keys but claims su='bob'.
		const envelope = buildSealedFirstContact({ initiator: spoofer, claimedName: 'bob', responderIdentity: alice, responderSpk: aliceSpk, payload: { t: 'text', text: 'i am totally bob' }, st: generateSealToken(), rid: generateSealToken(), id: 'N3' });
		const handshake = JSON.parse(new TextDecoder().decode(openBox(alice.dh.secretKey, base64ToBytes(envelope.x3dhSealed!))!)) as X3dhHandshakeWire;

		// The anti-spoof check compares the handshake's DH key to bob's REAL published
		// bundle key — mismatch ⇒ rejected. (A spoofer can't present bob's real key AND
		// complete X3DH, since they lack its private half.)
		const bobPublishedDhKey = bytesToBase64(realBob.dh.publicKey);
		expect(handshake.initiatorIdentityDhPublicKey).not.toBe(bobPublishedDhKey);
		// Whereas a genuine sender's handshake key DOES equal their published key.
		const genuine = buildSealedFirstContact({ initiator: realBob, claimedName: 'bob', responderIdentity: alice, responderSpk: aliceSpk, payload: { t: 'text', text: 'really bob' }, st: generateSealToken(), rid: generateSealToken(), id: 'N4' });
		const genuineHandshake = JSON.parse(new TextDecoder().decode(openBox(alice.dh.secretKey, base64ToBytes(genuine.x3dhSealed!))!)) as X3dhHandshakeWire;
		expect(genuineHandshake.initiatorIdentityDhPublicKey).toBe(bobPublishedDhKey);
	});
});
