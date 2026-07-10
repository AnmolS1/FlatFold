import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

const BASE = 'https://example.com';

async function attemptLogin(username: string, password: string): Promise<number> {
	const res = await SELF.fetch(`${BASE}/api/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password }),
	});
	return res.status;
}

describe('auth rate limiting (brute-force protection)', () => {
	it('throttles repeated login attempts for a username (429 after the limit)', async () => {
		// Create the account so attempts hit the password check, not validation.
		await SELF.fetch(`${BASE}/api/auth/signup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'brute_target', password: 'correcthorsebattery' }),
		});

		// LOGIN_LIMIT is 10 per window. The first 10 wrong-password attempts are
		// 401 (allowed but rejected); the 11th is throttled with 429.
		const statuses: number[] = [];
		for (let i = 0; i < 12; i++) {
			statuses.push(await attemptLogin('brute_target', 'wrong-password'));
		}

		const first10 = statuses.slice(0, 10);
		expect(first10.every((s) => s === 401)).toBe(true);
		expect(statuses[10]).toBe(429); // 11th attempt throttled
		expect(statuses[11]).toBe(429);
	});

	it('throttling is per-username — a different account is unaffected', async () => {
		await SELF.fetch(`${BASE}/api/auth/signup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'brute_bystander', password: 'correcthorsebattery' }),
		});
		// Even after another user is throttled, this account logs in fine.
		const ok = await attemptLogin('brute_bystander', 'correcthorsebattery');
		expect(ok).toBe(200);
	});
});
