// D7 Phase 2 — recovery-code crypto (pure). A 12-word BIP39 code (128-bit +
// checksum) drives two INDEPENDENT Argon2id derivations off separate salts:
//   • K_rec wraps the backed-up secret (the opaque recovery blob), and
//   • recAuth is the value sent to the server to prove ownership.
// The two use different salts, so the authenticator the server sees is never the
// wrapping key — the server can hold recAuth (hashed) yet never unwrap the blob.
//
// Runs under the jsdom project: deriveKeystoreKey uses hash-wasm (Argon2id),
// which workerd forbids.
import { describe, expect, it } from 'vitest';
import {
	generateRecoveryCode,
	normalizeRecoveryCode,
	deriveRecoveryWrapKey,
	deriveRecoveryAuth,
	buildRecoveryEnrollment,
	openRecoveryBlob,
	InvalidRecoveryCodeError,
} from '../src/keystore/recovery';
import { bytesToBase64 } from '../src/keystore/codec';

// Deterministic secrets — no RNG needed in the assertions.
const secretOf = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);

describe('recovery code generation + validation', () => {
	it('generates a 12-word code that validates', () => {
		const code = generateRecoveryCode();
		expect(code.split(' ').length).toBe(12);
		expect(() => normalizeRecoveryCode(code)).not.toThrow();
	});

	it('normalizes case and extra whitespace to the canonical code', () => {
		const code = generateRecoveryCode();
		const messy = '   ' + code.toUpperCase().replace(/ /g, '    ') + '  ';
		expect(normalizeRecoveryCode(messy)).toBe(code);
	});

	it('rejects a code with a bad checksum', () => {
		expect(() => normalizeRecoveryCode('abandon '.repeat(11) + 'abandon')).toThrow(InvalidRecoveryCodeError);
	});

	it('rejects a not-even-words string', () => {
		expect(() => normalizeRecoveryCode('this is definitely not a valid recovery code at all here')).toThrow(
			InvalidRecoveryCodeError
		);
	});
});

describe('recovery wrap / unwrap', () => {
	it('round-trips a secret: wrap under a fresh code, recover with the same code', async () => {
		const code = generateRecoveryCode();
		const secret = secretOf(64);
		const enroll = await buildRecoveryEnrollment(code, secret);
		const recovered = await openRecoveryBlob(code, enroll.saltRec, enroll.blob);
		expect(recovered).toEqual(secret);
	});

	it('recovers even when the code is typed messily (canonical-entropy invariance)', async () => {
		const code = generateRecoveryCode();
		const secret = secretOf(48, 3);
		const enroll = await buildRecoveryEnrollment(code, secret);
		const messy = code.toUpperCase().replace(/ /g, '   ');
		const recovered = await openRecoveryBlob(messy, enroll.saltRec, enroll.blob);
		expect(recovered).toEqual(secret);
	});

	it('a wrong code does not recover, and yields a different authenticator', async () => {
		const code = generateRecoveryCode();
		let wrong = generateRecoveryCode();
		while (wrong === code) wrong = generateRecoveryCode();
		const enroll = await buildRecoveryEnrollment(code, secretOf(16));
		await expect(openRecoveryBlob(wrong, enroll.saltRec, enroll.blob)).rejects.toBeInstanceOf(InvalidRecoveryCodeError);
		expect(await deriveRecoveryAuth(wrong, enroll.saltAuth)).not.toBe(enroll.auth);
	});

	it('tampering the blob makes recovery throw InvalidRecoveryCodeError', async () => {
		const code = generateRecoveryCode();
		const enroll = await buildRecoveryEnrollment(code, secretOf(24));
		const ct = enroll.blob.ciphertext;
		const tampered = { ...enroll.blob, ciphertext: (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1) };
		await expect(openRecoveryBlob(code, enroll.saltRec, tampered)).rejects.toBeInstanceOf(InvalidRecoveryCodeError);
	});
});

describe('recovery authenticator vs wrap key', () => {
	it('the authenticator is deterministic and DISTINCT from the wrap key (separate salts)', async () => {
		const code = generateRecoveryCode();
		const enroll = await buildRecoveryEnrollment(code, secretOf(32));

		// Deterministic: same code + salt reproduces the authenticator.
		expect(await deriveRecoveryAuth(code, enroll.saltAuth)).toBe(enroll.auth);

		// The value the server sees (auth) is not the key that unwraps the blob.
		const wrapKeyB64 = bytesToBase64(await deriveRecoveryWrapKey(code, enroll.saltRec));
		expect(enroll.auth).not.toBe(wrapKeyB64);
		expect(enroll.saltRec).not.toBe(enroll.saltAuth);
	});
});
