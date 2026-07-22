// Phase 1 (native apps): bearer-token auth for native clients, alongside the
// existing SameSite=Strict cookie for web. Native clients (capacitor://localhost)
// are cross-origin and can't use the cookie, so they:
//   - signal themselves with `X-FlatFold-Native: 1`,
//   - receive the session token in the response BODY (never a JS-readable body
//     for web — that stays httpOnly-cookie only),
//   - send it back as `Authorization: Bearer <token>` on /api/*,
//   - and smuggle it as a `Sec-WebSocket-Protocol` offer on /ws (the one channel
//     the in-webview JS WebSocket constructor controls, and the only one the
//     Worker can read at upgrade time to route to the per-user mailbox DO).
import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

const BASE = 'https://example.com';
const NATIVE = { 'X-FlatFold-Native': '1' };
const PASSWORD = 'correcthorsebattery';

async function nativeSignup(username: string): Promise<Response> {
	return SELF.fetch(`${BASE}/api/auth/signup`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...NATIVE },
		body: JSON.stringify({ username, password: PASSWORD }),
	});
}

async function nativeToken(username: string): Promise<string> {
	const body = (await (await nativeSignup(username)).json()) as { token: string };
	return body.token;
}

describe('native bearer auth — /api/*', () => {
	it('signup with the native header returns the token in the body and sets NO cookie', async () => {
		const res = await nativeSignup('native_alice');
		expect(res.status).toBe(200);
		expect(res.headers.get('Set-Cookie')).toBeNull();
		const body = (await res.json()) as { username: string; token?: string };
		expect(body.username).toBe('native_alice');
		expect(typeof body.token).toBe('string');
		expect(body.token!.split('.').length).toBe(2); // payload.sig
	});

	it('login with the native header returns the token in the body and no cookie', async () => {
		await nativeSignup('native_bob');
		const res = await SELF.fetch(`${BASE}/api/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...NATIVE },
			body: JSON.stringify({ username: 'native_bob', password: PASSWORD }),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('Set-Cookie')).toBeNull();
		expect(typeof ((await res.json()) as { token?: string }).token).toBe('string');
	});

	it('a Bearer token authenticates /api/auth/me and slides a fresh token in the body', async () => {
		const token = await nativeToken('native_carol');
		const res = await SELF.fetch(`${BASE}/api/auth/me`, {
			headers: { Authorization: `Bearer ${token}`, ...NATIVE },
		});
		expect(res.status).toBe(200);
		const me = (await res.json()) as { username: string; token?: string };
		expect(me.username).toBe('native_carol');
		expect(typeof me.token).toBe('string');
		expect(res.headers.get('Set-Cookie')).toBeNull();
	});

	it('a Bearer token authenticates a protected non-auth route (keys/bundle) — not 401', async () => {
		const token = await nativeToken('native_dave');
		const res = await SELF.fetch(`${BASE}/api/keys/bundle/native_dave`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).not.toBe(401);
	});

	it('an invalid Bearer token is rejected', async () => {
		const res = await SELF.fetch(`${BASE}/api/auth/me`, {
			headers: { Authorization: 'Bearer not.arealtoken', ...NATIVE },
		});
		expect(res.status).toBe(401);
	});

	it('a MALFORMED Bearer token fails closed with 401, never a 500', async () => {
		// "not.a.token": the sig part "a" is not valid base64url, so base64urlDecode's
		// atob would throw — which pre-fix propagated as a 500 (verifySessionPayload
		// decoded the sig outside its try/catch). Every shape below must be a clean 401.
		for (const bad of ['not.a.token', 'Bearer', '....', 'a.', 'onlyonepart', '.sig', '%%%.%%%']) {
			const res = await SELF.fetch(`${BASE}/api/auth/me`, {
				headers: { Authorization: `Bearer ${bad}`, ...NATIVE },
			});
			expect(res.status, `malformed token "${bad}"`).toBe(401);
		}
	});

	it('a Bearer token is revoked by sign-out-everywhere (epoch bump)', async () => {
		const token = await nativeToken('native_erin');
		const out = await SELF.fetch(`${BASE}/api/auth/logout-all`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...NATIVE },
			body: JSON.stringify({ password: PASSWORD }),
		});
		expect(out.status).toBe(200);
		const after = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
		expect(after.status).toBe(401);
	});
});

describe('CORS for native cross-origin /api/*', () => {
	it('OPTIONS preflight returns permissive CORS WITHOUT credentials', async () => {
		const res = await SELF.fetch(`${BASE}/api/auth/login`, {
			method: 'OPTIONS',
			headers: {
				Origin: 'capacitor://localhost',
				'Access-Control-Request-Method': 'POST',
				'Access-Control-Request-Headers': 'authorization,content-type,x-flatfold-native',
			},
		});
		expect([200, 204]).toContain(res.status);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
		// MUST NOT allow credentials — native uses bearer; cookies stay same-origin.
		expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
		expect((res.headers.get('Access-Control-Allow-Headers') ?? '').toLowerCase()).toContain('authorization');
	});

	it('actual /api responses carry Access-Control-Allow-Origin: * so native can read them', async () => {
		const res = await nativeSignup('cors_hank');
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});
});

describe('web cookie path is unchanged', () => {
	it('signup WITHOUT the native header still sets a cookie and returns no body token', async () => {
		const res = await SELF.fetch(`${BASE}/api/auth/signup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'web_frank', password: PASSWORD }),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('Set-Cookie')).toBeTruthy();
		const body = (await res.json()) as { username: string; token?: string };
		expect(body.username).toBe('web_frank');
		expect(body.token).toBeUndefined();
	});
});

describe('native /ws auth via Sec-WebSocket-Protocol', () => {
	it('a valid token in the subprotocol upgrades to 101 and echoes the benign subprotocol', async () => {
		const token = await nativeToken('ws_grace');
		const res = await SELF.fetch(`${BASE}/ws`, {
			headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `flatfold, flatfold.bearer.${token}` },
		});
		expect(res.status).toBe(101);
		expect(res.headers.get('Sec-WebSocket-Protocol')).toBe('flatfold');
	});

	it('rejects a /ws upgrade whose subprotocol token is invalid', async () => {
		const res = await SELF.fetch(`${BASE}/ws`, {
			headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'flatfold, flatfold.bearer.bogustoken' },
		});
		expect(res.status).toBe(401);
	});
});
