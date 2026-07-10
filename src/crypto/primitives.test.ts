// Test vectors for the underlying primitives, pulled byte-for-byte from
// the published RFCs (verified against the raw RFC text, not a
// re-transcription). Signal's X3DH and Double Ratchet specs — unlike these
// RFCs — don't publish an official numeric test-vector suite of their own;
// see x3dh.test.ts and doubleRatchet.test.ts for how those are tested
// instead (protocol-level property tests: roundtrips, tamper detection,
// out-of-order delivery, post-compromise recovery).
import { describe, expect, it } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils.js';
import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { aeadDecrypt, aeadEncrypt, hkdfSha256 } from './primitives';

describe('X25519 — RFC 7748 §6.1', () => {
	it('matches the Alice/Bob Diffie-Hellman test vector', () => {
		const alicePriv = hexToBytes('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
		const alicePub = hexToBytes('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
		const bobPriv = hexToBytes('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
		const bobPub = hexToBytes('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');
		const expectedShared = hexToBytes('4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742');

		expect(x25519.getPublicKey(alicePriv)).toEqual(alicePub);
		expect(x25519.getPublicKey(bobPriv)).toEqual(bobPub);
		expect(x25519.getSharedSecret(alicePriv, bobPub)).toEqual(expectedShared);
		expect(x25519.getSharedSecret(bobPriv, alicePub)).toEqual(expectedShared);
	});
});

describe('Ed25519 — RFC 8032 §7.1 TEST 1', () => {
	it('matches the empty-message sign/verify test vector', () => {
		const secretKey = hexToBytes('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
		const publicKey = hexToBytes('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
		const message = new Uint8Array(0);
		const expectedSignature = hexToBytes(
			'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'
		);

		expect(ed25519.getPublicKey(secretKey)).toEqual(publicKey);
		expect(ed25519.sign(message, secretKey)).toEqual(expectedSignature);
		expect(ed25519.verify(expectedSignature, message, publicKey)).toBe(true);
	});

	it('rejects a signature over a tampered message', () => {
		const publicKey = hexToBytes('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
		const signature = hexToBytes(
			'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'
		);

		expect(ed25519.verify(signature, new Uint8Array([1]), publicKey)).toBe(false);
	});
});

describe('HKDF-SHA256 — RFC 5869 Appendix A.1 Test Case 1', () => {
	it('matches the basic HKDF-SHA256 test vector', () => {
		const ikm = hexToBytes('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
		const salt = hexToBytes('000102030405060708090a0b0c');
		const info = hexToBytes('f0f1f2f3f4f5f6f7f8f9');
		const expectedOkm = hexToBytes(
			'3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865'
		);

		expect(hkdfSha256(ikm, salt, info, 42)).toEqual(expectedOkm);
	});
});

describe('AEAD (ChaCha20-Poly1305) roundtrip sanity', () => {
	it('decrypts what it encrypts, with matching associated data', () => {
		const key = new Uint8Array(32).fill(7);
		const nonce = new Uint8Array(12).fill(1);
		const plaintext = new TextEncoder().encode('the quick brown fox');
		const aad = new TextEncoder().encode('associated');

		const ciphertext = aeadEncrypt(key, nonce, plaintext, aad);
		expect(aeadDecrypt(key, nonce, ciphertext, aad)).toEqual(plaintext);
	});

	it('fails to decrypt when the associated data does not match', () => {
		const key = new Uint8Array(32).fill(7);
		const nonce = new Uint8Array(12).fill(1);
		const plaintext = new TextEncoder().encode('the quick brown fox');
		const ciphertext = aeadEncrypt(key, nonce, plaintext, new TextEncoder().encode('right-aad'));

		expect(() => aeadDecrypt(key, nonce, ciphertext, new TextEncoder().encode('wrong-aad'))).toThrow();
	});

	it('fails to decrypt tampered ciphertext', () => {
		const key = new Uint8Array(32).fill(7);
		const nonce = new Uint8Array(12).fill(1);
		const plaintext = new TextEncoder().encode('the quick brown fox');
		const ciphertext = aeadEncrypt(key, nonce, plaintext);
		const tampered = new Uint8Array(ciphertext);
		tampered[0] ^= 0xff;

		expect(() => aeadDecrypt(key, nonce, tampered)).toThrow();
	});
});
