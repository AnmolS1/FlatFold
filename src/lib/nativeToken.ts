// The native session bearer token store. Web never uses this (its token is an
// httpOnly cookie); only native (which receives the token in the response body)
// stores and re-sends it as `Authorization: Bearer`.
//
// INTERIM storage = localStorage, which persists across a WKWebView relaunch
// (the same durability the cookie gives web). Phase 1 HARDENING swaps this one
// module for the iOS Keychain / Android Keystore (hardware-backed, key-at-rest)
// via a Capacitor secure-storage plugin — the async signatures here already
// match a Keychain API so nothing else has to change. Until then the token is
// JS-readable, which is acceptable only because the native shell ships bundled,
// signed, no-remote-code assets (a tiny XSS surface vs the web).

const STORAGE_KEY = 'ff_native_token';

// `undefined` = not yet loaded from storage; `null` = loaded, no token present.
let cache: string | null | undefined = undefined;

// Async: loads from storage on first call, then serves the cache. Async so the
// Keychain swap is transparent.
export async function loadNativeToken(): Promise<string | null> {
	if (cache !== undefined) return cache;
	try {
		cache = window.localStorage.getItem(STORAGE_KEY);
	} catch {
		cache = null;
	}
	return cache;
}

// Synchronous in-memory read for the WebSocket path (can't await at construction
// time). Returns the value loaded by loadNativeToken(); the app calls that once
// at startup (via the initial /api/auth/me), so the cache is warm before any
// socket connects.
export function cachedNativeToken(): string | null {
	return cache ?? null;
}

export async function setNativeToken(token: string): Promise<void> {
	cache = token;
	try {
		window.localStorage.setItem(STORAGE_KEY, token);
	} catch {
		/* storage unavailable — the in-memory cache still serves this session */
	}
}

export async function clearNativeToken(): Promise<void> {
	cache = null;
	try {
		window.localStorage.removeItem(STORAGE_KEY);
	} catch {
		/* ignore */
	}
}
