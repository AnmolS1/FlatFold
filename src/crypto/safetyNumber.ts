// Safety numbers — a per-conversation fingerprint of both parties' identity
// keys that two people can compare out-of-band (read aloud, or scan as a QR)
// to detect a man-in-the-middle. Modeled on Signal's numeric fingerprint
// (an iterated SHA-512 over version + identity + a stable identifier),
// adapted for FlatFold's two-keypair identity.
//
// The one adaptation that matters: FlatFold's deliberate deviation from
// Signal's single XEdDSA key (see src/crypto/types.ts) means an identity is
// TWO public keys — an Ed25519 signing key and an X25519 DH key. Both
// authenticate the session (the signing key anchors the signed prekey; the
// DH key feeds DH1 of X3DH), so the fingerprint MUST commit to both. A
// fingerprint over only one would let an attacker swap the other key
// undetected. We hash the two concatenated in a fixed order.

import { sha512 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from './primitives';

// Signal uses 5200; matching it keeps the brute-force cost of grinding a
// colliding fingerprint high without being noticeable to compute once.
const ITERATIONS = 5200;
const VERSION = new Uint8Array([0, 0]);
// 6 five-digit chunks per party (30 digits each); two parties → a 60-digit
// safety number, displayed as 12 groups of 5.
const CHUNKS_PER_PARTY = 6;
const CHUNK_BYTES = 5;
const CHUNK_MODULUS = 100000;

export interface SafetyNumberIdentity {
	username: string;
	signingPublicKey: Uint8Array;
	dhPublicKey: Uint8Array;
}

// Iterated SHA-512 over (version || identity-keys || username). The username
// is the stable identifier binding the fingerprint to *who* these keys claim
// to be, so swapping keys for a given username changes the number.
function computeFingerprint(identity: SafetyNumberIdentity): Uint8Array {
	const identityKeys = concatBytes(identity.signingPublicKey, identity.dhPublicKey);
	let hash = sha512(concatBytes(VERSION, identityKeys, utf8ToBytes(identity.username)));
	for (let i = 0; i < ITERATIONS; i++) {
		hash = sha512(concatBytes(hash, identityKeys));
	}
	return hash;
}

function fingerprintDigits(fingerprint: Uint8Array): string {
	let digits = '';
	for (let chunk = 0; chunk < CHUNKS_PER_PARTY; chunk++) {
		const offset = chunk * CHUNK_BYTES;
		let value = 0;
		for (let b = 0; b < CHUNK_BYTES; b++) value = value * 256 + fingerprint[offset + b];
		digits += (value % CHUNK_MODULUS).toString().padStart(5, '0');
	}
	return digits;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
	for (let i = 0; i < a.length && i < b.length; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return a.length - b.length;
}

// The 60-digit safety number for a conversation. Symmetric: both parties
// compute the identical number regardless of who is "self" — the two
// fingerprints are ordered by byte comparison (lower first), not by role.
export function computeSafetyNumber(self: SafetyNumberIdentity, other: SafetyNumberIdentity): string {
	const selfFp = computeFingerprint(self);
	const otherFp = computeFingerprint(other);
	const [first, second] = compareBytes(selfFp, otherFp) <= 0 ? [selfFp, otherFp] : [otherFp, selfFp];
	return fingerprintDigits(first) + fingerprintDigits(second);
}

// "123456789012..." -> "12345 67890 12..." for readable comparison.
export function formatSafetyNumber(safetyNumber: string): string {
	return (safetyNumber.match(/.{1,5}/g) ?? []).join(' ');
}
