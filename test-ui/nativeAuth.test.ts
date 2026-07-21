// Phase 1 client wiring: the native (capacitor://localhost) branch of the API
// layer. Native is detected via the `window.Capacitor` bridge; it targets the
// absolute API origin, sends `X-FlatFold-Native`, captures the session token
// from the response BODY, and attaches it as `Authorization: Bearer` on later
// calls. Web behaviour must be completely unchanged (relative URL, cookie, no
// token in JS storage).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN_KEY = 'ff_native_token';

function setNative(on: boolean): void {
	const w = window as unknown as { Capacitor?: { isNativePlatform: () => boolean } };
	if (on) w.Capacitor = { isNativePlatform: () => true };
	else delete w.Capacitor;
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
	return new Headers(init?.headers).get(name);
}

describe('API layer — web path unchanged', () => {
	beforeEach(() => {
		vi.resetModules();
		window.localStorage.clear();
		setNative(false);
	});
	afterEach(() => vi.restoreAllMocks());

	it('signup uses a relative URL, sends no native header, stores no token', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ username: 'web_u' }), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const { apiSignup } = await import('../src/lib/api');

		const result = await apiSignup('web_u', 'password12');
		expect(result.username).toBe('web_u');

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('/api/auth/signup');
		expect(headerOf(init, 'X-FlatFold-Native')).toBeNull();
		expect(init.credentials).toBe('include');
		expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
	});
});

describe('API layer — native bearer path', () => {
	beforeEach(() => {
		vi.resetModules();
		window.localStorage.clear();
		setNative(true);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		setNative(false);
	});

	it('signup hits the absolute origin with X-FlatFold-Native and captures the body token', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ username: 'nat_u', token: 'PAYLOAD.SIG' }), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const { apiSignup } = await import('../src/lib/api');

		await apiSignup('nat_u', 'password12');

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://flatfold.ponderance.dev/api/auth/signup');
		expect(headerOf(init, 'X-FlatFold-Native')).toBe('1');
		// credentials must be OMITted cross-origin: a credentialed request against
		// the server's ACAO:* (no Allow-Credentials) would be blocked by the browser.
		expect(init.credentials).toBe('omit');
		expect(window.localStorage.getItem(TOKEN_KEY)).toBe('PAYLOAD.SIG');
	});

	it('a later authed call attaches the captured token as Authorization: Bearer', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ username: 'nat_u', token: 'PAYLOAD.SIG' }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ username: 'nat_u' }), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const { apiSignup, apiMe } = await import('../src/lib/api');

		await apiSignup('nat_u', 'password12');
		await apiMe();

		const [meUrl, meInit] = fetchMock.mock.calls[1] as [string, RequestInit];
		expect(meUrl).toBe('https://flatfold.ponderance.dev/api/auth/me');
		expect(headerOf(meInit, 'Authorization')).toBe('Bearer PAYLOAD.SIG');
	});

	it('me refreshes the stored token when the body carries a new one', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ username: 'nat_u', token: 'REFRESHED.SIG' }), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const { apiMe } = await import('../src/lib/api');

		await apiMe();
		expect(window.localStorage.getItem(TOKEN_KEY)).toBe('REFRESHED.SIG');
	});

	it('a 401 from /me clears the dead stored token', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"Not authenticated."}', { status: 401 }));
		vi.stubGlobal('fetch', fetchMock);
		window.localStorage.setItem(TOKEN_KEY, 'DEAD.SIG');
		const { apiMe } = await import('../src/lib/api');

		expect(await apiMe()).toBeNull();
		expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
	});

	it('logout clears the stored native token', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		window.localStorage.setItem(TOKEN_KEY, 'PAYLOAD.SIG');
		const { apiLogout } = await import('../src/lib/api');

		await apiLogout();
		expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
	});
});
