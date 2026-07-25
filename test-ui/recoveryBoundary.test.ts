// Regression guard for the client↔server boundary of the recovery blob. The
// blob is an EncryptedBlob OBJECT in memory, but the D1 column is TEXT and the
// server guards `typeof === 'string'` — so the client MUST serialize it to a
// JSON string on the wire and parse it back on return. Pure-crypto round-trip
// tests can't see this: they never cross JSON/HTTP/D1. This test mocks the fetch
// layer to assert the on-wire shape is a string that still decrypts.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../src/lib/apiClient', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import { apiEnrollRecovery, apiRecoveryReset } from '../src/lib/api';
import { buildRecoveryEnrollment, generateRecoveryCode, openRecoveryBlob } from '../src/keystore/recovery';

function okJson(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
const secretOf = (n: number, s = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 5 + s) & 0xff);

beforeEach(() => apiFetch.mockReset());

describe('recovery blob crosses the wire as a JSON string', () => {
	it('apiEnrollRecovery sends blob as a STRING that parses back and decrypts', async () => {
		let sent: Record<string, unknown> | null = null;
		apiFetch.mockImplementation((_path: string, init?: RequestInit) => {
			sent = init?.body ? JSON.parse(init.body as string) : null;
			return Promise.resolve(okJson({ ok: true }));
		});

		const code = generateRecoveryCode();
		const secret = secretOf(32);
		const enrollment = await buildRecoveryEnrollment(code, secret);
		await apiEnrollRecovery('pw', {
			saltRec: enrollment.saltRec,
			saltAuth: enrollment.saltAuth,
			blob: enrollment.blob,
			auth: enrollment.auth,
		});

		// The D1 TEXT column + server `typeof === 'string'` guard require a string.
		expect(typeof sent!.blob).toBe('string');
		// And the stored string must parse back to a blob that still decrypts.
		const recovered = await openRecoveryBlob(code, enrollment.saltRec, JSON.parse(sent!.blob as string));
		expect(recovered).toEqual(secret);
	});

	it('apiRecoveryReset returns the stored TEXT blob, which parses + decrypts', async () => {
		const code = generateRecoveryCode();
		const secret = secretOf(24, 3);
		const enrollment = await buildRecoveryEnrollment(code, secret);
		const storedText = JSON.stringify(enrollment.blob); // what the server column holds

		apiFetch.mockResolvedValue(okJson({ blob: storedText }));
		const result = await apiRecoveryReset('u', 'recauth', 'new-pw');
		expect(result).not.toBe('wrong-code');
		const blob = JSON.parse((result as { blob: unknown }).blob as string);
		expect(await openRecoveryBlob(code, enrollment.saltRec, blob)).toEqual(secret);
	});
});
