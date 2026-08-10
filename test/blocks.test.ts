// App Review 1.2: blocking, enforced by the server rather than by the recipient's
// device choosing not to look. And ejecting a terminated account.
//
// The distinction that matters for the review notes: before this, a block hid
// messages that had already been delivered. Now the mailbox refuses the delivery,
// so "a blocked account cannot deliver at all" is a true sentence.
import { describe, expect, it } from 'vitest';
import { env, runInDurableObject, SELF } from 'cloudflare:test';

const BASE = 'https://example.com';
const PASSWORD = 'correcthorsebattery';

async function signup(username: string): Promise<string> {
	const res = await SELF.fetch(`${BASE}/api/auth/signup`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password: PASSWORD }),
	});
	const cookie = res.headers.get('Set-Cookie')?.split(';')[0];
	if (!cookie) throw new Error('no session cookie');
	return cookie;
}

describe('server-side blocking', () => {
	it('records a block and lists it back', async () => {
		const cookie = await signup('blk_alice');
		await signup('blk_pest');

		const res = await SELF.fetch(`${BASE}/api/blocks`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ username: 'blk_pest' }),
		});
		expect(res.status).toBe(200);

		const list = await SELF.fetch(`${BASE}/api/blocks`, { headers: { Cookie: cookie } });
		expect(await list.json()).toEqual({ blocked: ['blk_pest'] });
	});

	it('is idempotent — blocking twice is not an error', async () => {
		const cookie = await signup('blk_bob');
		await signup('blk_twice');
		for (let i = 0; i < 2; i++) {
			const res = await SELF.fetch(`${BASE}/api/blocks`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Cookie: cookie },
				body: JSON.stringify({ username: 'blk_twice' }),
			});
			expect(res.status).toBe(200);
		}
		const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM blocks WHERE blocker = ?')
			.bind('blk_bob')
			.first<{ n: number }>();
		expect(row?.n).toBe(1);
	});

	it('unblocking removes the row', async () => {
		const cookie = await signup('blk_carol');
		await signup('blk_gone');
		await SELF.fetch(`${BASE}/api/blocks`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ username: 'blk_gone' }),
		});
		const res = await SELF.fetch(`${BASE}/api/blocks`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({ username: 'blk_gone' }),
		});
		expect(res.status).toBe(200);
		const list = await SELF.fetch(`${BASE}/api/blocks`, { headers: { Cookie: cookie } });
		expect(await list.json()).toEqual({ blocked: [] });
	});

	it('rejects unauthenticated block management', async () => {
		expect((await SELF.fetch(`${BASE}/api/blocks`)).status).toBe(401);
	});
});

describe('account termination (ejecting a user)', () => {
	it('a disabled account cannot authenticate with an existing session', async () => {
		const cookie = await signup('term_pest');

		// Works before termination.
		expect((await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })).status).toBe(200);

		await env.DB.prepare('UPDATE users SET disabled_at = ? WHERE username = ?')
			.bind(1_700_000_000, 'term_pest')
			.run();

		// The live session dies too — terminating an account that is currently
		// signed in must not wait for the token to expire.
		expect((await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })).status).toBe(401);
	});

	it('a disabled account cannot log back in', async () => {
		await signup('term_relog');
		await env.DB.prepare('UPDATE users SET disabled_at = ? WHERE username = ?')
			.bind(1_700_000_000, 'term_relog')
			.run();

		const res = await SELF.fetch(`${BASE}/api/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'term_relog', password: PASSWORD }),
		});
		expect(res.status).toBe(401);
	});

	it('a retired username cannot be registered again', async () => {
		await env.DB.prepare('INSERT INTO banned_usernames (username, banned_at) VALUES (?, ?)')
			.bind('term_retired', 1_700_000_000)
			.run();

		const res = await SELF.fetch(`${BASE}/api/auth/signup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'term_retired', password: PASSWORD }),
		});
		expect(res.status).toBe(409);
		// And the generic "taken" wording is deliberate — it must not advertise
		// which handles were retired for abuse.
		expect(await env.DB.prepare('SELECT username FROM users WHERE username = ?').bind('term_retired').first()).toBeNull();
	});
});

// The claim in the review notes is "a blocked account cannot deliver at all".
// That is a statement about the DELIVERY PATH, not about the API that records the
// block, so it needs its own test — the endpoint tests above would all still pass
// if the mailbox ignored the table entirely.
describe('a blocked sender cannot deliver', () => {
	async function connect(username: string): Promise<{ ws: WebSocket; cookie: string }> {
		const cookie = await signup(username);
		const wsRes = await SELF.fetch(`${BASE}/ws`, { headers: { Upgrade: 'websocket', Cookie: cookie } });
		expect(wsRes.status).toBe(101);
		const ws = wsRes.webSocket!;
		ws.accept();
		return { ws, cookie };
	}

	async function queuedCount(username: string): Promise<number> {
		const stub = env.MAILBOX.getByName(username);
		// The send crosses two DOs asynchronously; poll rather than sleep.
		const deadline = Date.now() + 1500;
		let n = 0;
		do {
			n = await runInDurableObject(stub, async (_i, state) => {
				const list = await state.storage.list({ prefix: 'envelope:' });
				return [...list.keys()].length;
			});
			if (n > 0) return n;
			await new Promise((r) => setTimeout(r, 5));
		} while (Date.now() < deadline);
		return n;
	}

	it('drops the envelope instead of queueing it, and tells the sender nothing', async () => {
		const pest = await connect('deliv_pest');
		const victimCookie = await signup('deliv_victim');

		await SELF.fetch(`${BASE}/api/blocks`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: victimCookie },
			body: JSON.stringify({ username: 'deliv_pest' }),
		});

		pest.ws.send(JSON.stringify({ type: 'send', to: 'deliv_victim', ciphertext: 'blocked-payload', header: {} }));

		expect(await queuedCount('deliv_victim')).toBe(0);
	});

	it('still delivers when there is no block — the control', async () => {
		const friend = await connect('deliv_friend');
		await signup('deliv_ok');

		friend.ws.send(JSON.stringify({ type: 'send', to: 'deliv_ok', ciphertext: 'ordinary-payload', header: {} }));

		// Without this control, the test above would pass just as well against a
		// mailbox that had stopped delivering anything at all.
		expect(await queuedCount('deliv_ok')).toBe(1);
	});
});
