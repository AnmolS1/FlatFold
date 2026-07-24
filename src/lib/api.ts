// Typed wrappers for the /api/* endpoints. All calls go through `apiFetch`
// (lib/apiClient), which handles the web-vs-native split: web uses a relative
// URL + the httpOnly SameSite=Strict cookie; native uses the absolute origin +
// `Authorization: Bearer`. See worker/auth.ts for why web is cookie-only.
//
// The session token is returned in the BODY only for native (signup/login/me);
// those three capture it into the native token store. Web bodies carry no token.

import type { PreKeyBundleResponse, PublishKeysRequest } from '../types';
import { apiFetch } from './apiClient';
import { isNativePlatform } from './platform';
import { clearNativeToken, setNativeToken } from './nativeToken';

async function parseJsonOrThrow(response: Response): Promise<unknown> {
	const body = await response.json().catch(() => null);
	if (!response.ok) {
		const message = (body as { error?: string } | null)?.error ?? 'Something went wrong. Please try again.';
		throw new Error(message);
	}
	return body;
}

// Native auth responses carry the token in the body — persist it so later calls
// (and the WebSocket) can attach it. No-op for web (body has no token).
async function captureNativeToken(body: unknown): Promise<void> {
	if (!isNativePlatform()) return;
	const token = (body as { token?: unknown } | null)?.token;
	if (typeof token === 'string' && token.length > 0) await setNativeToken(token);
}

export async function apiSignup(username: string, password: string): Promise<{ username: string }> {
	const response = await apiFetch('/api/auth/signup', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password }),
	});
	const body = (await parseJsonOrThrow(response)) as { username: string; token?: string };
	await captureNativeToken(body);
	return { username: body.username };
}

export async function apiLogin(username: string, password: string): Promise<{ username: string }> {
	const response = await apiFetch('/api/auth/login', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password }),
	});
	const body = (await parseJsonOrThrow(response)) as { username: string; token?: string };
	await captureNativeToken(body);
	return { username: body.username };
}

export interface MeResponse {
	username: string;
	sessionCreatedAt?: number; // unix seconds — the token's iat
}

export async function apiMe(): Promise<MeResponse | null> {
	const response = await apiFetch('/api/auth/me');
	if (response.status === 401) {
		// The token is dead (expired / epoch-bumped) — drop it so we stop
		// re-sending a credential the server will only reject. Web clears via
		// its own cookie lifecycle; this is the native equivalent.
		if (isNativePlatform()) await clearNativeToken();
		return null;
	}
	const body = (await parseJsonOrThrow(response)) as MeResponse & { token?: string };
	await captureNativeToken(body); // native: sliding refresh returns a fresh token
	return { username: body.username, sessionCreatedAt: body.sessionCreatedAt };
}

export async function apiLogout(): Promise<void> {
	await apiFetch('/api/auth/logout', { method: 'POST' });
	await clearNativeToken(); // web clears via Set-Cookie; native drops its stored token
}

// "Sign out everywhere" (L3): password re-auth, then the server bumps the
// session epoch, invalidating every session token including this device's. The
// caller redirects to login; the local keystore is left intact (this ends
// logins, not the account).
export async function apiLogoutAll(password: string): Promise<void> {
	const response = await apiFetch('/api/auth/logout-all', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password }),
	});
	await parseJsonOrThrow(response);
	await clearNativeToken(); // the epoch bump invalidated this token server-side too
}

// Change password (D7 §1): re-auth with the current password, set the new one,
// and bump the epoch (other sessions die). The server returns a FRESH token for
// this session at the new epoch — captured here for native so this device stays
// signed in (web gets the refreshed cookie). Throws on any non-2xx (wrong current
// password → the caller rolls back its staged local re-wrap).
export async function apiChangePassword(current: string, next: string): Promise<void> {
	const response = await apiFetch('/api/auth/change-password', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ current, new: next }),
	});
	const body = await parseJsonOrThrow(response);
	await captureNativeToken(body);
}

// Irreversible: deletes the server-side account (D1 rows + queued ciphertext)
// after password re-auth. The caller must ALSO wipe the local keystore.
export async function apiDeleteAccount(password: string): Promise<void> {
	const response = await apiFetch('/api/account', {
		method: 'DELETE',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password }),
	});
	await parseJsonOrThrow(response);
}

export async function apiPublishKeys(request: PublishKeysRequest): Promise<void> {
	const response = await apiFetch('/api/keys/publish', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(request),
	});
	await parseJsonOrThrow(response);
}

// Sealed sender: register (or rotate) my delivery token with my own mailbox DO,
// which holds the authoritative valid set that gates incoming sealed sends. The
// DO keeps the newest few for a rotation grace window. Idempotent — re-called on
// every login to converge the DO's set with my published bundle. Register with
// the DO BEFORE publishing the token in the bundle: a bundle token the DO won't
// accept breaks first-contact, whereas a DO token not yet in the bundle is
// simply not handed out — the safe failure direction.
export async function apiRegisterSealToken(token: string): Promise<void> {
	const response = await apiFetch('/api/seal/register-token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ token }),
	});
	await parseJsonOrThrow(response);
}

// Native APNs push subscription (iOS). The device token is opaque; the server
// stores it to send content-free wake-ups. environment omitted → server default
// 'production' (matches the app's aps-environment for TestFlight/App Store).
export async function apiSubscribeApns(deviceToken: string): Promise<void> {
	const response = await apiFetch('/api/push/apns/subscribe', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ deviceToken }),
	});
	await parseJsonOrThrow(response);
}

export async function apiUnsubscribeApns(deviceToken: string): Promise<void> {
	const response = await apiFetch('/api/push/apns/unsubscribe', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ deviceToken }),
	});
	await parseJsonOrThrow(response);
}

export type FetchBundleResult =
	| { status: 'ok'; bundle: PreKeyBundleResponse }
	| { status: 'not-found' }
	| { status: 'not-published' };

export async function apiFetchBundle(username: string): Promise<FetchBundleResult> {
	const response = await apiFetch(`/api/keys/bundle/${encodeURIComponent(username)}`);
	if (response.status === 404) return { status: 'not-found' };
	if (response.status === 409) return { status: 'not-published' };
	const bundle = (await parseJsonOrThrow(response)) as PreKeyBundleResponse;
	return { status: 'ok', bundle };
}
