// Master-key (MK) wrap/unwrap primitives — the foundation of D7 (change
// password, recovery, biometric unlock). A random MK encrypts every store; MK
// itself is AEAD-wrapped under keys derived from the password / recovery code /
// biometric. These tests pin the crypto contract: round-trip, wrong-key and
// tamper failure, and nonce freshness.
import { describe, expect, it } from 'vitest';
import { generateMasterKey, wrapKey, unwrapKey } from './crypto';
import { randomBytes } from '../crypto/primitives';

describe('generateMasterKey', () => {
	it('returns 32 random bytes', () => {
		const mk = generateMasterKey();
		expect(mk).toBeInstanceOf(Uint8Array);
		expect(mk.length).toBe(32);
	});

	it('returns a different value each call', () => {
		expect(bytesEqual(generateMasterKey(), generateMasterKey())).toBe(false);
	});
});

describe('wrapKey / unwrapKey', () => {
	it('round-trips the master key under a wrapping key', () => {
		const wrappingKey = randomBytes(32);
		const mk = generateMasterKey();
		const wrapped = wrapKey(wrappingKey, mk);
		expect(bytesEqual(unwrapKey(wrappingKey, wrapped), mk)).toBe(true);
	});

	it('throws when unwrapped with the wrong key (the wrong-password oracle)', () => {
		const mk = generateMasterKey();
		const wrapped = wrapKey(randomBytes(32), mk);
		expect(() => unwrapKey(randomBytes(32), wrapped)).toThrow();
	});

	it('throws when the wrapped blob is tampered', () => {
		const wrappingKey = randomBytes(32);
		const wrapped = wrapKey(wrappingKey, generateMasterKey());
		const ct = base64ToBytesLocal(wrapped.ciphertext);
		ct[0] ^= 0xff;
		const tampered = { ...wrapped, ciphertext: bytesToBase64Local(ct) };
		expect(() => unwrapKey(wrappingKey, tampered)).toThrow();
	});

	it('uses a fresh nonce each wrap (same key twice → different ciphertext)', () => {
		const wrappingKey = randomBytes(32);
		const mk = generateMasterKey();
		const a = wrapKey(wrappingKey, mk);
		const b = wrapKey(wrappingKey, mk);
		expect(a.nonce).not.toBe(b.nonce);
		expect(a.ciphertext).not.toBe(b.ciphertext);
	});
});

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	return a.every((v, i) => v === b[i]);
}
function base64ToBytesLocal(b64: string): Uint8Array {
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function bytesToBase64Local(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}
