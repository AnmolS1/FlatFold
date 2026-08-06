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

export async function apiSignup(username: string, password: string): Promise<{ username: string; termsAccepted: boolean }> {
	const response = await apiFetch('/api/auth/signup', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password }),
	});
	const body = (await parseJsonOrThrow(response)) as { username: string; token?: string; termsAccepted?: boolean };
	await captureNativeToken(body);
	// `!== false` so an older Worker (no field) reads as accepted — see MeResponse.
	return { username: body.username, termsAccepted: body.termsAccepted !== false };
}

// Login, 2FA-aware. When the account has 2FA on, a password-only attempt returns
// 'two-factor-required' (server 401 {twoFactorRequired}); the caller re-invokes
// with the authenticator/backup code. Other failures throw.
export async function apiLogin(
	username: string,
	password: string,
	code?: string
): Promise<{ username: string; termsAccepted: boolean } | 'two-factor-required'> {
	const response = await apiFetch('/api/auth/login', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(code ? { username, password, code } : { username, password }),
	});
	if (response.status === 401) {
		const body = (await response.json().catch(() => null)) as { twoFactorRequired?: boolean; error?: string } | null;
		if (body?.twoFactorRequired) return 'two-factor-required';
		throw new Error(body?.error ?? 'Invalid username or password.');
	}
	const body = (await parseJsonOrThrow(response)) as { username: string; token?: string; termsAccepted?: boolean };
	await captureNativeToken(body);
	return { username: body.username, termsAccepted: body.termsAccepted !== false };
}

// Turn on TOTP two-factor (D7 §4). Password-reauthed; the server verifies the
// confirming `code` against `secret` before storing it. Backup codes are hashed
// server-side. The secret + codes are generated client-side (src/lib/totp.ts).
export async function apiEnable2fa(password: string, secret: string, code: string, backupCodes: string[]): Promise<void> {
	const response = await apiFetch('/api/auth/2fa/enable', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password, secret, code, backupCodes }),
	});
	await parseJsonOrThrow(response);
}

// Turn off TOTP two-factor. Requires the password AND a valid second factor.
export async function apiDisable2fa(password: string, code: string): Promise<void> {
	const response = await apiFetch('/api/auth/2fa/disable', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password, code }),
	});
	await parseJsonOrThrow(response);
}

export interface MeResponse {
	username: string;
	sessionCreatedAt?: number; // unix seconds — the token's iat
	twoFactorEnabled?: boolean; // D7 §4 — drives the Settings 2FA section
	// App Review 1.2 — whether this account has accepted the CURRENT terms.
	// Absent from an older Worker ⇒ treated as accepted, not as gated: a client
	// deployed ahead of the Worker must not lock every existing user out of the
	// app with a gate whose accept endpoint does not exist yet.
	termsAccepted?: boolean;
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
	return {
		username: body.username,
		sessionCreatedAt: body.sessionCreatedAt,
		twoFactorEnabled: body.twoFactorEnabled,
		termsAccepted: body.termsAccepted,
	};
}

// App Review 1.2: record that this account accepted the terms. The version is
// decided by the server — deliberately not sent from here.
export async function apiAcceptTerms(): Promise<void> {
	const response = await apiFetch('/api/account/accept-terms', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
	});
	await parseJsonOrThrow(response);
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

// ---- account recovery (D7 §3) ----

// Enroll (or replace) a recovery code. Password-reauthed server-side. The blob +
// authenticator are opaque here — built by the keystore (keystore.enrollRecovery).
export interface RecoveryUpload {
	saltRec: string;
	saltAuth: string;
	blob: unknown; // EncryptedBlob JSON — opaque to the transport
	auth: string;
}
export async function apiEnrollRecovery(password: string, upload: RecoveryUpload): Promise<void> {
	const response = await apiFetch('/api/auth/recovery/enroll', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		// The blob is an EncryptedBlob OBJECT; the server column is TEXT and its
		// guard expects a string — serialize it here (parsed back on recovery).
		body: JSON.stringify({
			password,
			saltRec: upload.saltRec,
			saltAuth: upload.saltAuth,
			blob: JSON.stringify(upload.blob),
			auth: upload.auth,
		}),
	});
	await parseJsonOrThrow(response);
}

// The public recovery salts for a username. Null when the account has no recovery
// enrolled (server 404) — the caller shows the honest "no way back" copy.
export async function apiRecoveryParams(username: string): Promise<{ saltRec: string; saltAuth: string } | null> {
	const response = await apiFetch(`/api/auth/recovery/params?username=${encodeURIComponent(username)}`);
	if (response.status === 404) return null;
	return (await parseJsonOrThrow(response)) as { saltRec: string; saltAuth: string };
}

// Recover: authenticate with the recovery authenticator, set a new password, and
// receive the opaque recovery blob (to rebuild the identity locally). Captures the
// fresh session token for native. Returns 'wrong-code' on a bad authenticator
// (server 401); throws on other failures (429 rate-limit, network).
export async function apiRecoveryReset(
	username: string,
	recAuth: string,
	newPassword: string
): Promise<{ blob: unknown } | 'wrong-code'> {
	const response = await apiFetch('/api/auth/recovery/reset', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, recAuth, newPassword }),
	});
	if (response.status === 401) return 'wrong-code';
	const body = (await parseJsonOrThrow(response)) as { blob: unknown; token?: string };
	await captureNativeToken(body);
	return { blob: body.blob };
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

// App Review 1.2: file an abuse report. `evidence` is ONLY ever the messages the
// reporter explicitly selected, after the consent step in ReportDialog — never
// the conversation, never anything gathered automatically. The server cannot
// read messages, so this is the only way a report can carry what it is about.
export interface ReportEvidenceMessage {
	from: string;
	ts: number;
	text: string;
}

export async function apiReport(
	reported: string,
	reason: string,
	evidence: ReportEvidenceMessage[]
): Promise<void> {
	const response = await apiFetch('/api/report', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ reported, reason, evidence }),
	});
	await parseJsonOrThrow(response);
}

// App Review 1.2: server-side blocking. The local list in lib/blocklist.ts stays
// — it is what catches a SEALED send, which the server cannot filter because it
// does not know who sent it. These keep the server copy in step so a block also
// stops delivery, applies on every device, and survives a reinstall.
export async function apiBlock(username: string): Promise<void> {
	const response = await apiFetch('/api/blocks', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username }),
	});
	await parseJsonOrThrow(response);
}

export async function apiUnblock(username: string): Promise<void> {
	const response = await apiFetch('/api/blocks', {
		method: 'DELETE',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username }),
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

// How many of MY one-time prekeys are left on the server. Drives replenishment
// (src/lib/prekeyReplenish.ts).
export async function apiGetPreKeyCount(): Promise<number> {
	const response = await apiFetch('/api/keys/prekeys');
	const body = (await parseJsonOrThrow(response)) as { remaining?: number };
	return body.remaining ?? 0;
}

// Top up ONLY the one-time prekey pool. Deliberately not /api/keys/publish,
// which would also rewrite the identity + signed prekey and read as a key
// change to every contact.
export async function apiAddOneTimePreKeys(oneTimePreKeys: string[]): Promise<void> {
	const response = await apiFetch('/api/keys/prekeys', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ oneTimePreKeys }),
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
