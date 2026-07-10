// Signal's X3DH spec (signal.org/docs/specifications/x3dh/) does not
// publish an official numeric test-vector suite the way RFC-style
// primitive specs do — there's no fixed "given these exact bytes, expect
// this exact shared secret" table to wire up. So this is tested at the
// protocol level instead: run both sides of a real handshake and assert
// they agree, and that tampering is caught.
import { describe, expect, it } from 'vitest';
import {
	generateIdentityKeyPair,
	generateOneTimePreKeys,
	generateSignedPreKey,
	initiateX3DH,
	respondX3DH,
	verifySignedPreKey,
} from './x3dh';
import type { IdentityPublicKeys } from './types';

function publicKeysOf(identity: ReturnType<typeof generateIdentityKeyPair>): IdentityPublicKeys {
	return { signingPublicKey: identity.signing.publicKey, dhPublicKey: identity.dh.publicKey };
}

describe('X3DH handshake', () => {
	it('initiator and responder derive the same shared secret and associated data (with a one-time prekey)', () => {
		const alice = generateIdentityKeyPair();
		const bob = generateIdentityKeyPair();
		const bobSignedPreKey = generateSignedPreKey(bob);
		const [bobOneTimePreKey] = generateOneTimePreKeys(1);

		const initiatorResult = initiateX3DH({
			initiatorIdentity: alice,
			responderIdentity: publicKeysOf(bob),
			responderSignedPreKey: { publicKey: bobSignedPreKey.keyPair.publicKey, signature: bobSignedPreKey.signature },
			responderOneTimePreKey: bobOneTimePreKey.keyPair.publicKey,
		});

		const responderResult = respondX3DH({
			responderIdentity: bob,
			responderSignedPreKey: bobSignedPreKey,
			responderOneTimePreKey: bobOneTimePreKey,
			initiatorIdentityDhPublicKey: alice.dh.publicKey,
			initiatorEphemeralPublicKey: initiatorResult.ephemeralPublicKey,
		});

		expect(initiatorResult.sharedSecret).toEqual(responderResult.sharedSecret);
		expect(initiatorResult.associatedData).toEqual(responderResult.associatedData);
		expect(initiatorResult.usedOneTimePreKey).toBe(true);
	});

	it('agrees on a shared secret with no one-time prekey available', () => {
		const alice = generateIdentityKeyPair();
		const bob = generateIdentityKeyPair();
		const bobSignedPreKey = generateSignedPreKey(bob);

		const initiatorResult = initiateX3DH({
			initiatorIdentity: alice,
			responderIdentity: publicKeysOf(bob),
			responderSignedPreKey: { publicKey: bobSignedPreKey.keyPair.publicKey, signature: bobSignedPreKey.signature },
		});

		const responderResult = respondX3DH({
			responderIdentity: bob,
			responderSignedPreKey: bobSignedPreKey,
			initiatorIdentityDhPublicKey: alice.dh.publicKey,
			initiatorEphemeralPublicKey: initiatorResult.ephemeralPublicKey,
		});

		expect(initiatorResult.sharedSecret).toEqual(responderResult.sharedSecret);
		expect(initiatorResult.usedOneTimePreKey).toBe(false);
	});

	it('produces different shared secrets across independent handshakes (fresh ephemeral each time)', () => {
		const alice = generateIdentityKeyPair();
		const bob = generateIdentityKeyPair();
		const bobSignedPreKey = generateSignedPreKey(bob);
		const bundle = { publicKey: bobSignedPreKey.keyPair.publicKey, signature: bobSignedPreKey.signature };

		const first = initiateX3DH({ initiatorIdentity: alice, responderIdentity: publicKeysOf(bob), responderSignedPreKey: bundle });
		const second = initiateX3DH({ initiatorIdentity: alice, responderIdentity: publicKeysOf(bob), responderSignedPreKey: bundle });

		expect(first.sharedSecret).not.toEqual(second.sharedSecret);
	});

	it('rejects a signed prekey whose signature does not verify', () => {
		const alice = generateIdentityKeyPair();
		const bob = generateIdentityKeyPair();
		const bobSignedPreKey = generateSignedPreKey(bob);
		const tamperedSignature = new Uint8Array(bobSignedPreKey.signature);
		tamperedSignature[0] ^= 0xff;

		expect(() =>
			initiateX3DH({
				initiatorIdentity: alice,
				responderIdentity: publicKeysOf(bob),
				responderSignedPreKey: { publicKey: bobSignedPreKey.keyPair.publicKey, signature: tamperedSignature },
			})
		).toThrow(/signature verification failed/i);
	});

	it('rejects a signed prekey signed by the wrong identity', () => {
		const alice = generateIdentityKeyPair();
		const bob = generateIdentityKeyPair();
		const mallory = generateIdentityKeyPair();
		const preKeySignedByMallory = generateSignedPreKey(mallory);

		expect(() =>
			initiateX3DH({
				initiatorIdentity: alice,
				responderIdentity: publicKeysOf(bob), // claims to be Bob...
				responderSignedPreKey: {
					publicKey: preKeySignedByMallory.keyPair.publicKey,
					signature: preKeySignedByMallory.signature, // ...but the signature is Mallory's
				},
			})
		).toThrow(/signature verification failed/i);
	});

	it('verifySignedPreKey is the same check used internally by initiateX3DH', () => {
		const bob = generateIdentityKeyPair();
		const bobSignedPreKey = generateSignedPreKey(bob);

		expect(
			verifySignedPreKey(bob.signing.publicKey, bobSignedPreKey.keyPair.publicKey, bobSignedPreKey.signature)
		).toBe(true);
	});
});
