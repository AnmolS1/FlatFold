// D7 Phase 3 — TOTP (RFC 6238) client helpers. The client's whole job is
// enrollment: generate the shared secret, render it as an otpauth:// URI (→ QR)
// for the user's authenticator app, and generate one-time backup codes. It NEVER
// computes or verifies TOTP codes — the authenticator produces them and the
// server verifies them (worker/totp.ts).
//
// Client-only, but pure (no hash-wasm/IndexedDB): just CSPRNG bytes + base32.
import { base32, base32crockford } from '@scure/base';
import { randomBytes } from '../crypto/primitives';

const TOTP_SECRET_BYTES = 20; // 160-bit shared secret (standard for TOTP)
const BACKUP_CODE_BYTES = 10; // 80-bit per code — comfortably past the 64-bit floor
const BACKUP_CODE_COUNT = 10;

// A fresh TOTP shared secret as unpadded RFC-4648 base32 (the encoding every
// authenticator app expects in an otpauth secret).
export function generateTotpSecret(): string {
	return base32.encode(randomBytes(TOTP_SECRET_BYTES));
}

// The otpauth:// URI for the QR + manual entry. SHA1 / 6 digits / 30s is the
// universal default that every authenticator implements.
export function buildOtpauthUri(secret: string, account: string, issuer: string): string {
	const label = encodeURIComponent(`${issuer}:${account}`);
	const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
	return `otpauth://totp/${label}?${params.toString()}`;
}

// Ten single-use backup codes, each 80-bit CSPRNG, Crockford base32 (no ambiguous
// I/L/O/U), grouped for hand-typing. The high entropy is what makes a fast
// server-side hash safe — see test-ui/totp.test.ts, which pins the ≥64-bit floor.
export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
	return Array.from({ length: count }, () => {
		const raw = base32crockford.encode(randomBytes(BACKUP_CODE_BYTES));
		return raw.match(/.{1,4}/g)!.join('-');
	});
}

// Strip grouping/whitespace and upper-case so a hand-typed code matches what was
// hashed. Both enrollment (client→server) and login normalize the same way.
export function normalizeBackupCode(code: string): string {
	return code.replace(/[\s-]/g, '').toUpperCase();
}
