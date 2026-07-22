// The native session bearer token store. Web never uses this (its token is an
// httpOnly cookie); only native (which receives the token in the response body)
// stores and re-sends it as `Authorization: Bearer`.
//
// Native storage = the iOS Keychain / Android Keystore via
// @aparajita/capacitor-secure-storage (hardware-backed, key-at-rest — the
// Phase 1 security requirement, an upgrade over web where the token would sit in
// JS-readable storage). The plugin's async API matched the signatures this
// module was designed with, so this is the only file that changed. A tiny
// in-memory `cache` backs the SYNCHRONOUS read the WebSocket path needs at
// connect time; it's warmed by the startup /api/auth/me before any socket opens.
//
// The `localStorage` branch is the web fallback (never hit in practice, since
// web uses the cookie and never calls these) and keeps the module usable + unit-
// testable off-device.
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { isNativePlatform } from './platform';

const STORAGE_KEY = 'ff_native_token';

// `undefined` = not yet loaded; `null` = loaded, no token present.
let cache: string | null | undefined = undefined;

export async function loadNativeToken(): Promise<string | null> {
	if (cache !== undefined) return cache;
	try {
		if (isNativePlatform()) {
			const value = await SecureStorage.get(STORAGE_KEY);
			cache = typeof value === 'string' ? value : null;
		} else {
			cache = window.localStorage.getItem(STORAGE_KEY);
		}
	} catch {
		cache = null;
	}
	return cache;
}

// Synchronous in-memory read for the WebSocket path (can't await at construction
// time). Serves the value loaded by loadNativeToken(), which the startup
// /api/auth/me calls, so the cache is warm before any socket connects.
export function cachedNativeToken(): string | null {
	return cache ?? null;
}

export async function setNativeToken(token: string): Promise<void> {
	cache = token;
	try {
		if (isNativePlatform()) await SecureStorage.set(STORAGE_KEY, token);
		else window.localStorage.setItem(STORAGE_KEY, token);
	} catch {
		/* storage unavailable — the in-memory cache still serves this session */
	}
}

export async function clearNativeToken(): Promise<void> {
	cache = null;
	try {
		if (isNativePlatform()) await SecureStorage.remove(STORAGE_KEY);
		else window.localStorage.removeItem(STORAGE_KEY);
	} catch {
		/* ignore */
	}
}
