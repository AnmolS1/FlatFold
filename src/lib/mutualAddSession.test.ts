// Reproduces the "Header decryption failed — no matching header key" that
// Anmol hit on a real phone/laptop pair the first time each side added the
// other and then sent.
//
// Cause: adding a contact eagerly establishes a session. handleAddContact ->
// ensureSession -> initiateX3DH + initRatchetAsInitiator, stored immediately.
// So if BOTH users add each other before either sends, both hold an INITIATOR
// session, built from two different X3DH runs and therefore two different
// shared secrets. Header keys come from the shared secret
// (deriveSharedHeaderKeys), so neither side's header keys match the other's.
//
// The receive path in messaging.ts then does:
//
//   let sess = keyChanged ? null : await keystore.loadSession(...)
//   if (!sess) { ...respondX3DH... }        // <- the ONLY path that responds
//   plaintext = ratchetDecrypt(sess.ratchet, ...)
//
// An existing session shadows the incoming `frame.x3dh`, so respondX3DH never
// runs and ratchetDecrypt throws. Note this also explains the "verification
// fixed it" red herring: setVerified/acknowledgeKeyChange never touch sessions,
// but `keyChanged` forces sess = null, which is what actually rebuilt the
// responder session.
//
// These tests work at the crypto layer (no keystore/IndexedDB, so they run in
// the workers pool) and pin the protocol behavior the fix has to produce.
import { describe, expect, it } from 'vitest';
import {
	generateIdentityKeyPair,
	generateSignedPreKey,
	initiateX3DH,
	respondX3DH,
} from '../crypto/x3dh';
import { initRatchetAsInitiator, initRatchetAsResponder, ratchetDecrypt, ratchetEncrypt, tryRatchetDecrypt } from '../crypto/doubleRatchet';
import type { IdentityPublicKeys, SignedPreKey } from '../crypto/types';

type Identity = ReturnType<typeof generateIdentityKeyPair>;

const publicKeysOf = (identity: Identity): IdentityPublicKeys => ({
	signingPublicKey: identity.signing.publicKey,
	dhPublicKey: identity.dh.publicKey,
});

const utf8 = (s: string) => new TextEncoder().encode(s);

/** What ensureSession does on `addContact`: an eager INITIATOR session. */
function addContact(me: Identity, peer: Identity, peerSignedPreKey: SignedPreKey) {
	const handshake = initiateX3DH({
		initiatorIdentity: me,
		responderIdentity: publicKeysOf(peer),
		responderSignedPreKey: { publicKey: peerSignedPreKey.keyPair.publicKey, signature: peerSignedPreKey.signature },
	});
	return {
		ratchet: initRatchetAsInitiator(handshake.sharedSecret, peerSignedPreKey.keyPair.publicKey),
		associatedData: handshake.associatedData,
		// The x3dh material that rides the first message.
		wire: { initiatorIdentityDhPublicKey: me.dh.publicKey, initiatorEphemeralPublicKey: handshake.ephemeralPublicKey },
	};
}

/** What the receive path SHOULD do with an incoming x3dh: a RESPONDER session. */
function respondTo(me: Identity, mySignedPreKey: SignedPreKey, wire: { initiatorIdentityDhPublicKey: Uint8Array; initiatorEphemeralPublicKey: Uint8Array }) {
	const handshake = respondX3DH({
		responderIdentity: me,
		responderSignedPreKey: mySignedPreKey,
		initiatorIdentityDhPublicKey: wire.initiatorIdentityDhPublicKey,
		initiatorEphemeralPublicKey: wire.initiatorEphemeralPublicKey,
	});
	return { ratchet: initRatchetAsResponder(handshake.sharedSecret, mySignedPreKey.keyPair), associatedData: handshake.associatedData };
}

function setup() {
	const alice = generateIdentityKeyPair();
	const bob = generateIdentityKeyPair();
	return { alice, bob, aliceSpk: generateSignedPreKey(alice), bobSpk: generateSignedPreKey(bob) };
}

describe('mutual-add session collision (first contact)', () => {
	it('a lone initiator session decrypts fine — the baseline that works today', () => {
		// Only Alice adds Bob. Bob has no session, so the receive path builds the
		// responder session from the x3dh material. This is the happy path.
		const { alice, bob, bobSpk } = setup();
		const aliceSession = addContact(alice, bob, bobSpk);

		const sent = ratchetEncrypt(aliceSession.ratchet, utf8('hello'), aliceSession.associatedData);
		const bobSession = respondTo(bob, bobSpk, aliceSession.wire);

		expect(new TextDecoder().decode(ratchetDecrypt(bobSession.ratchet, sent.encryptedHeader, sent.ciphertext, bobSession.associatedData))).toBe('hello');
	});

	it('REPRODUCES THE BUG: when both sides added each other, the receiver cannot decrypt', () => {
		// Both add each other before either sends — the exact reported scenario.
		const { alice, bob, aliceSpk, bobSpk } = setup();
		const aliceSession = addContact(alice, bob, bobSpk);
		const bobSession = addContact(bob, alice, aliceSpk);

		const sent = ratchetEncrypt(aliceSession.ratchet, utf8('hello'), aliceSession.associatedData);

		// This is what messaging.ts does today: an existing session shadows the
		// incoming x3dh, so it decrypts against Bob's own INITIATOR session.
		expect(() => ratchetDecrypt(bobSession.ratchet, sent.encryptedHeader, sent.ciphertext, bobSession.associatedData)).toThrow(
			/no matching header key/
		);
	});

	it('is deterministic, not a race — it fails on every attempt', () => {
		// Discriminates a session collision (always) from a write race
		// (intermittent). Ten independent pairs, ten failures.
		for (let i = 0; i < 10; i++) {
			const { alice, bob, aliceSpk, bobSpk } = setup();
			const aliceSession = addContact(alice, bob, bobSpk);
			const bobSession = addContact(bob, alice, aliceSpk);
			const sent = ratchetEncrypt(aliceSession.ratchet, utf8(`msg ${i}`), aliceSession.associatedData);
			expect(tryRatchetDecrypt(bobSession.ratchet, sent.encryptedHeader, sent.ciphertext, bobSession.associatedData)).toBeNull();
		}
	});

	it('the fallback works: trial-decrypt first, then respond to the x3dh', () => {
		// The shape of the fix. tryRatchetDecrypt returns null on a header
		// mismatch WITHOUT mutating state, so falling back to respondX3DH is safe.
		const { alice, bob, aliceSpk, bobSpk } = setup();
		const aliceSession = addContact(alice, bob, bobSpk);
		const bobSession = addContact(bob, alice, aliceSpk);
		const sent = ratchetEncrypt(aliceSession.ratchet, utf8('hello'), aliceSession.associatedData);

		let plaintext = tryRatchetDecrypt(bobSession.ratchet, sent.encryptedHeader, sent.ciphertext, bobSession.associatedData);
		expect(plaintext).toBeNull(); // existing session doesn't match...
		const responder = respondTo(bob, bobSpk, aliceSession.wire); // ...so respond to the x3dh
		plaintext = ratchetDecrypt(responder.ratchet, sent.encryptedHeader, sent.ciphertext, responder.associatedData);

		expect(new TextDecoder().decode(plaintext!)).toBe('hello');
	});

	it('GLARE: if both sides sent first, both adopting the responder session breaks the pairing', () => {
		// Why the fallback alone is not sufficient, and why the fix needs a
		// deterministic tie-break. Both sent before either received, so both
		// would adopt a responder session — leaving each paired with an
		// initiator session the other side has just discarded.
		const { alice, bob, aliceSpk, bobSpk } = setup();
		const aliceSession = addContact(alice, bob, bobSpk);
		const bobSession = addContact(bob, alice, aliceSpk);

		const aliceSent = ratchetEncrypt(aliceSession.ratchet, utf8('from alice'), aliceSession.associatedData);
		const bobSent = ratchetEncrypt(bobSession.ratchet, utf8('from bob'), bobSession.associatedData);

		// Each adopts a responder session to read the other's message.
		const bobAdopted = respondTo(bob, bobSpk, aliceSession.wire);
		const aliceAdopted = respondTo(alice, aliceSpk, bobSession.wire);
		expect(ratchetDecrypt(bobAdopted.ratchet, aliceSent.encryptedHeader, aliceSent.ciphertext, bobAdopted.associatedData)).toBeTruthy();
		expect(ratchetDecrypt(aliceAdopted.ratchet, bobSent.encryptedHeader, bobSent.ciphertext, aliceAdopted.associatedData)).toBeTruthy();

		// But now Alice sends on her adopted (responder) session, and Bob — who
		// also adopted — can no longer read her. The sessions have ping-ponged.
		const aliceNext = ratchetEncrypt(aliceAdopted.ratchet, utf8('after glare'), aliceAdopted.associatedData);
		expect(tryRatchetDecrypt(bobAdopted.ratchet, aliceNext.encryptedHeader, aliceNext.ciphertext, bobAdopted.associatedData)).toBeNull();
	});
});
