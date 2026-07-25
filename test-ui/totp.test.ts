// D7 Phase 3a — TOTP client helpers (pure). The client only generates the shared
// secret, the otpauth:// URI (for the QR), and the backup codes; it NEVER computes
// TOTP codes — the authenticator app does that and the server verifies (worker/totp).
//
// The backup-code entropy invariant is load-bearing: the server stores backup
// codes as a fast SHA-256 hash, which is only safe because each code is high-
// entropy. A later "make them friendlier" change to short codes would silently
// gut that — so the entropy floor is pinned here as the first test.
import { describe, expect, it } from 'vitest';
import { base32, base32crockford } from '@scure/base';
import {
	generateTotpSecret,
	buildOtpauthUri,
	generateBackupCodes,
	normalizeBackupCode,
} from '../src/lib/totp';

describe('backup codes (entropy is the storage model)', () => {
	it('each code carries >= 64 bits (decodes to >= 8 bytes) of CSPRNG entropy', () => {
		for (const code of generateBackupCodes()) {
			const bytes = base32crockford.decode(normalizeBackupCode(code));
			expect(bytes.length).toBeGreaterThanOrEqual(8);
		}
	});

	it('generates 10 distinct codes', () => {
		const codes = generateBackupCodes();
		expect(codes.length).toBe(10);
		expect(new Set(codes.map(normalizeBackupCode)).size).toBe(10);
	});

	it('normalizes formatting + case for comparison', () => {
		expect(normalizeBackupCode('abcd-efgh-jkmn')).toBe('ABCDEFGHJKMN');
		expect(normalizeBackupCode('  ABCD EFGH  ')).toBe('ABCDEFGH');
	});

	it('codes are unique across runs (not a constant)', () => {
		expect(generateBackupCodes()[0]).not.toBe(generateBackupCodes()[0]);
	});
});

describe('TOTP secret + otpauth URI', () => {
	it('generates a 160-bit RFC-4648 base32 secret (unpadded, A-Z2-7)', () => {
		const secret = generateTotpSecret();
		expect(secret).toMatch(/^[A-Z2-7]+$/);
		expect(base32.decode(secret).length).toBe(20);
	});

	it('secrets differ per call', () => {
		expect(generateTotpSecret()).not.toBe(generateTotpSecret());
	});

	it('builds a standard otpauth:// URI (SHA1 / 6 digits / 30s)', () => {
		const uri = buildOtpauthUri('JBSWY3DPEHPK3PXP', 'alice', 'FlatFold');
		expect(uri.startsWith('otpauth://totp/')).toBe(true);
		expect(uri).toContain('FlatFold%3Aalice'); // issuer:account label, URI-encoded
		expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
		expect(uri).toContain('issuer=FlatFold');
		expect(uri).toContain('algorithm=SHA1');
		expect(uri).toContain('digits=6');
		expect(uri).toContain('period=30');
	});
});
