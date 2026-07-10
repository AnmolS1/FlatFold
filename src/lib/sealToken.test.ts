import { describe, expect, it } from 'vitest';
import { generateSealToken } from './sealToken';

describe('sealed-sender delivery token', () => {
	it('generates a token the mailbox DO will accept (>= 16 chars)', () => {
		// The DO's handleRegisterToken rejects anything shorter than 16.
		expect(generateSealToken().length).toBeGreaterThanOrEqual(16);
	});

	it('is a printable base64 string (safe to carry in JSON / a URL-ish field)', () => {
		expect(generateSealToken()).toMatch(/^[A-Za-z0-9+/]+=*$/);
	});

	it('is unpredictable — no two tokens collide across many draws', () => {
		const seen = new Set<string>();
		for (let i = 0; i < 1000; i++) seen.add(generateSealToken());
		expect(seen.size).toBe(1000);
	});
});
