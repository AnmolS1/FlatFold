import { describe, expect, it } from 'vitest';
import { openResponse, sealResponse, SEALED_RESPONSE_EXPORT_LENGTH } from '../shared/sealedResponse';

// Pure round-trip of the RFC 9458 §4.4 encapsulated-response construction, run
// in the workerd environment (where the gateway actually seals). `secret` stands
// in for the HPKE exporter secret; `enc` for the request's encapsulated key.
const secret = () => crypto.getRandomValues(new Uint8Array(SEALED_RESPONSE_EXPORT_LENGTH));
const enc = () => crypto.getRandomValues(new Uint8Array(65)); // DHKEM(P-256) enc length

describe('sealed response (RFC 9458 §4.4 exporter-secret AEAD)', () => {
	it('round-trips a payload sealed with the same secret + enc', async () => {
		const s = secret();
		const e = enc();
		const pt = new TextEncoder().encode(JSON.stringify({ hello: 'bundle', n: 42 }));
		const blob = await sealResponse(s, e, pt);
		const out = await openResponse(s, e, blob);
		expect(new TextDecoder().decode(out)).toBe(new TextDecoder().decode(pt));
	});

	it('fails to open if a ciphertext byte is tampered (AEAD integrity)', async () => {
		const s = secret();
		const e = enc();
		const blob = await sealResponse(s, e, new TextEncoder().encode('secret'));
		blob[blob.length - 1] ^= 0x01; // flip a tag byte
		await expect(openResponse(s, e, blob)).rejects.toBeTruthy();
	});

	it('fails to open under the wrong secret or wrong enc', async () => {
		const e = enc();
		const blob = await sealResponse(secret(), e, new TextEncoder().encode('x'));
		await expect(openResponse(secret(), e, blob)).rejects.toBeTruthy(); // wrong secret
		await expect(openResponse(secret(), enc(), blob)).rejects.toBeTruthy(); // wrong enc
	});

	it('pads to a fixed length so different payloads are size-indistinguishable', async () => {
		const s = secret();
		const e = enc();
		const short = await sealResponse(s, e, new TextEncoder().encode('a'));
		const long = await sealResponse(s, e, new TextEncoder().encode('a'.repeat(400)));
		expect(short.length).toBe(long.length);
	});
});
