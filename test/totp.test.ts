// D7 Phase 3 — server TOTP. RFC 6238 Appendix B publishes canonical test vectors
// for the SHA-1 secret "12345678901234567890"; matching them is the ground truth
// that the HMAC/truncation is correct. Plus window/replay behavior, at-rest
// round-trip, and backup-code hashing.
import { describe, expect, it } from 'vitest';
import { base32 } from '@scure/base';
import {
	computeTotp,
	verifyTotp,
	totpStep,
	encryptTotpSecret,
	decryptTotpSecret,
	hashBackupCode,
} from '../worker/totp';

const RFC_SECRET_BYTES = new TextEncoder().encode('12345678901234567890');
const RFC_SECRET_B32 = base32.encode(RFC_SECRET_BYTES);

describe('TOTP RFC 6238 vectors (6-digit)', () => {
	const cases: [number, string][] = [
		[59, '287082'],
		[1111111109, '081804'],
		[1111111111, '050471'],
		[1234567890, '005924'],
		[2000000000, '279037'],
	];
	for (const [t, expected] of cases) {
		it(`T=${t}s → ${expected}`, async () => {
			expect(await computeTotp(RFC_SECRET_BYTES, totpStep(t * 1000))).toBe(expected);
		});
	}
});

describe('verifyTotp — window + replay', () => {
	it('accepts the current step', async () => {
		const now = 59000;
		const code = await computeTotp(RFC_SECRET_BYTES, totpStep(now));
		expect(await verifyTotp(RFC_SECRET_B32, code, now)).toBe(1);
	});

	it('tolerates ±1 step of clock skew', async () => {
		const now = 60000; // step 2; window [1,3]
		expect(await verifyTotp(RFC_SECRET_B32, await computeTotp(RFC_SECRET_BYTES, 1), now)).toBe(1);
		expect(await verifyTotp(RFC_SECRET_B32, await computeTotp(RFC_SECRET_BYTES, 3), now)).toBe(3);
	});

	it('rejects a code two steps away', async () => {
		const now = 60000;
		expect(await verifyTotp(RFC_SECRET_B32, await computeTotp(RFC_SECRET_BYTES, 5), now)).toBeNull();
	});

	it('rejects malformed codes', async () => {
		expect(await verifyTotp(RFC_SECRET_B32, '000', 59000)).toBeNull();
		expect(await verifyTotp(RFC_SECRET_B32, 'abcdef', 59000)).toBeNull();
	});

	it('replay guard: a step at or before the last-used one is rejected', async () => {
		const now = 59000; // step 1
		const code = await computeTotp(RFC_SECRET_BYTES, 1);
		expect(await verifyTotp(RFC_SECRET_B32, code, now, 1)).toBeNull(); // last-used = 1
		expect(await verifyTotp(RFC_SECRET_B32, code, now, 0)).toBe(1); // last-used = 0
	});

	it('documented papercut: a 2nd login in the same 30s step is blocked once step 1 is recorded', async () => {
		const now = 59000;
		const code = await computeTotp(RFC_SECRET_BYTES, 1);
		const step = await verifyTotp(RFC_SECRET_B32, code, now);
		expect(step).toBe(1);
		expect(await verifyTotp(RFC_SECRET_B32, code, now, step!)).toBeNull();
	});
});

describe('at-rest secret encryption', () => {
	it('round-trips under the same session secret and is opaque', async () => {
		const enc = await encryptTotpSecret('sess-secret', RFC_SECRET_B32);
		expect(enc).not.toContain(RFC_SECRET_B32);
		expect(await decryptTotpSecret('sess-secret', enc)).toBe(RFC_SECRET_B32);
	});

	it('does not decrypt under a different session secret (rotation lockout)', async () => {
		const enc = await encryptTotpSecret('sess-secret', RFC_SECRET_B32);
		await expect(decryptTotpSecret('other-secret', enc)).rejects.toBeTruthy();
	});
});

describe('backup-code hashing', () => {
	it('is deterministic after normalization (grouping/case)', async () => {
		expect(await hashBackupCode('alice', 'abcd-efgh-jkmn')).toBe(await hashBackupCode('alice', 'ABCDEFGHJKMN'));
	});

	it('is salted by username', async () => {
		expect(await hashBackupCode('alice', 'abcd-efgh')).not.toBe(await hashBackupCode('bob', 'abcd-efgh'));
	});
});
