// Typed fetch wrappers for the /api/* endpoints. `credentials: 'include'`
// sends/receives the httpOnly session cookie on every call — see
// worker/auth.ts for why a cookie (not a header/localStorage token) is the
// one auth mechanism shared by both /api/* and the /ws handshake.

import type { PreKeyBundleResponse, PublishKeysRequest } from '../types';

async function parseJsonOrThrow(response: Response): Promise<unknown> {
	const body = await response.json().catch(() => null);
	if (!response.ok) {
		const message = (body as { error?: string } | null)?.error ?? 'Something went wrong. Please try again.';
		throw new Error(message);
	}
	return body;
}

export async function apiSignup(username: string, password: string): Promise<{ username: string }> {
	const response = await fetch('/api/auth/signup', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({ username, password }),
	});
	return parseJsonOrThrow(response) as Promise<{ username: string }>;
}

export async function apiLogin(username: string, password: string): Promise<{ username: string }> {
	const response = await fetch('/api/auth/login', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({ username, password }),
	});
	return parseJsonOrThrow(response) as Promise<{ username: string }>;
}

export interface MeResponse {
	username: string;
	sessionCreatedAt?: number; // unix seconds — the token's iat
}

export async function apiMe(): Promise<MeResponse | null> {
	const response = await fetch('/api/auth/me', { credentials: 'include' });
	if (response.status === 401) return null;
	return parseJsonOrThrow(response) as Promise<MeResponse>;
}

export async function apiLogout(): Promise<void> {
	await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
}

// "Sign out everywhere" (L3): password re-auth, then the server bumps the
// session epoch, invalidating every session token including this device's. The
// caller redirects to login; the local keystore is left intact (this ends
// logins, not the account).
export async function apiLogoutAll(password: string): Promise<void> {
	const response = await fetch('/api/auth/logout-all', {
		method: 'POST',
		credentials: 'include',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password }),
	});
	await parseJsonOrThrow(response);
}

// Irreversible: deletes the server-side account (D1 rows + queued ciphertext)
// after password re-auth. The caller must ALSO wipe the local keystore.
export async function apiDeleteAccount(password: string): Promise<void> {
	const response = await fetch('/api/account', {
		method: 'DELETE',
		credentials: 'include',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password }),
	});
	await parseJsonOrThrow(response);
}

export async function apiPublishKeys(request: PublishKeysRequest): Promise<void> {
	const response = await fetch('/api/keys/publish', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
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
	const response = await fetch('/api/seal/register-token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({ token }),
	});
	await parseJsonOrThrow(response);
}

export type FetchBundleResult =
	| { status: 'ok'; bundle: PreKeyBundleResponse }
	| { status: 'not-found' }
	| { status: 'not-published' };

export async function apiFetchBundle(username: string): Promise<FetchBundleResult> {
	const response = await fetch(`/api/keys/bundle/${encodeURIComponent(username)}`, { credentials: 'include' });
	if (response.status === 404) return { status: 'not-found' };
	if (response.status === 409) return { status: 'not-published' };
	const bundle = (await parseJsonOrThrow(response)) as PreKeyBundleResponse;
	return { status: 'ok', bundle };
}
