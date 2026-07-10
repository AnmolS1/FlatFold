// Thin wrappers around audited primitives — @noble/curves, @noble/ciphers,
// @noble/hashes. No hand-rolled curve arithmetic or AEADs; this file only
// picks parameters and glues the pieces together.

import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { concatBytes, randomBytes, utf8ToBytes, bytesToHex } from '@noble/hashes/utils.js';
import type { KeyPair } from './types';

export const X25519_PUBLIC_KEY_LENGTH = 32;
export const AEAD_KEY_LENGTH = 32;
export const AEAD_NONCE_LENGTH = 12;

export function generateX25519KeyPair(): KeyPair {
	return x25519.keygen();
}

export function generateEd25519KeyPair(): KeyPair {
	return ed25519.keygen();
}

export function x25519SharedSecret(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
	// noble rejects low-order/all-zero points here rather than returning a
	// degenerate shared secret — the classic X25519 small-subgroup pitfall
	// is handled at this layer, not left to callers.
	return x25519.getSharedSecret(secretKey, publicKey);
}

export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
	return ed25519.sign(message, secretKey);
}

export function verifySignature(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
	return ed25519.verify(signature, message, publicKey);
}

export function hkdfSha256(ikm: Uint8Array, salt: Uint8Array | undefined, info: Uint8Array, length: number): Uint8Array {
	return hkdf(sha256, ikm, salt, info, length);
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
	return hmac(sha256, key, message);
}

export function sha256Hash(message: Uint8Array): Uint8Array {
	return sha256(message);
}

export function aeadEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, associatedData?: Uint8Array): Uint8Array {
	return chacha20poly1305(key, nonce, associatedData).encrypt(plaintext);
}

export function aeadDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, associatedData?: Uint8Array): Uint8Array {
	return chacha20poly1305(key, nonce, associatedData).decrypt(ciphertext);
}

export { concatBytes, randomBytes, utf8ToBytes, bytesToHex };
