// X3DH (Extended Triple Diffie-Hellman) — signal.org/docs/specifications/x3dh/
//
// One deliberate deviation from Signal's exact construction, documented in
// types.ts: identity keys are two separate keypairs (X25519 DH + Ed25519
// signing) rather than one XEdDSA dual-purpose key. Everything else follows
// the published spec, including the constant-F prefix on the DH
// concatenation and aborting on an invalid signed-prekey signature.

import {
	concatBytes,
	generateEd25519KeyPair,
	generateX25519KeyPair,
	hkdfSha256,
	sign,
	utf8ToBytes,
	verifySignature,
	x25519SharedSecret,
} from './primitives';
import type {
	IdentityKeyPair,
	OneTimePreKey,
	SignedPreKey,
	X3DHInitiatorParams,
	X3DHInitiatorResult,
	X3DHResponderParams,
	X3DHResponderResult,
} from './types';

const X3DH_INFO = utf8ToBytes('FlatFold-X3DH-v1');
const SHARED_SECRET_LENGTH = 32;

// A field-size run of 0xFF bytes, prepended to the DH concatenation before
// hashing (the spec's recommended "F" constant). This defends against
// small-subgroup / invalid-point attacks that could otherwise force a DH
// output to a fixed, attacker-known value: a genuine X25519 output can
// never equal this specific 32-byte constant, so hashing it in front closes
// off that confusion. Belt-and-suspenders here — @noble's x25519 already
// rejects the low-order inputs that make this class of attack possible —
// but the spec calls for it regardless and it costs nothing.
const F = new Uint8Array(32).fill(0xff);

export function generateIdentityKeyPair(): IdentityKeyPair {
	return {
		signing: generateEd25519KeyPair(),
		dh: generateX25519KeyPair(),
	};
}

export function generateSignedPreKey(identity: IdentityKeyPair): SignedPreKey {
	const keyPair = generateX25519KeyPair();
	const signature = sign(keyPair.publicKey, identity.signing.secretKey);
	return { keyPair, signature };
}

export function verifySignedPreKey(
	identitySigningPublicKey: Uint8Array,
	signedPreKeyPublicKey: Uint8Array,
	signature: Uint8Array
): boolean {
	return verifySignature(signature, signedPreKeyPublicKey, identitySigningPublicKey);
}

export function generateOneTimePreKeys(count: number): OneTimePreKey[] {
	return Array.from({ length: count }, () => ({ keyPair: generateX25519KeyPair() }));
}

function deriveSharedSecret(dhOutputs: Uint8Array[]): Uint8Array {
	const ikm = concatBytes(F, ...dhOutputs);
	// Zero-filled salt — the spec's recommendation absent a separate salt
	// negotiation — and a fixed application-specific info string.
	const salt = new Uint8Array(32);
	return hkdfSha256(ikm, salt, X3DH_INFO, SHARED_SECRET_LENGTH);
}

/**
 * Alice's side: given Bob's published prekey bundle, verify it and derive
 * the shared secret plus everything Bob needs to derive the same secret
 * (her identity DH public key and fresh ephemeral public key travel with
 * the first message — that wiring is a later milestone's job).
 */
export function initiateX3DH(params: X3DHInitiatorParams): X3DHInitiatorResult {
	const { initiatorIdentity, responderIdentity, responderSignedPreKey, responderOneTimePreKey } = params;

	if (
		!verifySignedPreKey(
			responderIdentity.signingPublicKey,
			responderSignedPreKey.publicKey,
			responderSignedPreKey.signature
		)
	) {
		throw new Error('Signed prekey signature verification failed — aborting X3DH handshake.');
	}

	const ephemeral = generateX25519KeyPair();

	const dh1 = x25519SharedSecret(initiatorIdentity.dh.secretKey, responderSignedPreKey.publicKey);
	const dh2 = x25519SharedSecret(ephemeral.secretKey, responderIdentity.dhPublicKey);
	const dh3 = x25519SharedSecret(ephemeral.secretKey, responderSignedPreKey.publicKey);
	const dhOutputs = [dh1, dh2, dh3];

	if (responderOneTimePreKey) {
		dhOutputs.push(x25519SharedSecret(ephemeral.secretKey, responderOneTimePreKey));
	}

	const sharedSecret = deriveSharedSecret(dhOutputs);
	const associatedData = concatBytes(initiatorIdentity.dh.publicKey, responderIdentity.dhPublicKey);

	return {
		sharedSecret,
		associatedData,
		ephemeralPublicKey: ephemeral.publicKey,
		usedOneTimePreKey: !!responderOneTimePreKey,
	};
}

/**
 * Bob's side: given Alice's identity DH public key and the ephemeral
 * public key that arrived with her first message, re-derive the same
 * shared secret. Callers are responsible for deleting the consumed
 * one-time prekey afterward — X3DH's one-time-use guarantee lives at the
 * storage layer, not in this pure function.
 */
export function respondX3DH(params: X3DHResponderParams): X3DHResponderResult {
	const {
		responderIdentity,
		responderSignedPreKey,
		responderOneTimePreKey,
		initiatorIdentityDhPublicKey,
		initiatorEphemeralPublicKey,
	} = params;

	const dh1 = x25519SharedSecret(responderSignedPreKey.keyPair.secretKey, initiatorIdentityDhPublicKey);
	const dh2 = x25519SharedSecret(responderIdentity.dh.secretKey, initiatorEphemeralPublicKey);
	const dh3 = x25519SharedSecret(responderSignedPreKey.keyPair.secretKey, initiatorEphemeralPublicKey);
	const dhOutputs = [dh1, dh2, dh3];

	if (responderOneTimePreKey) {
		dhOutputs.push(x25519SharedSecret(responderOneTimePreKey.keyPair.secretKey, initiatorEphemeralPublicKey));
	}

	const sharedSecret = deriveSharedSecret(dhOutputs);
	const associatedData = concatBytes(initiatorIdentityDhPublicKey, responderIdentity.dh.publicKey);

	return { sharedSecret, associatedData };
}
