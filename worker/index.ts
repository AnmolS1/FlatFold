// Worker entry point. Handles exactly two route families — the assets
// layer (configured in wrangler.jsonc via `run_worker_first`) serves
// everything else directly, so this fetch handler never has to think
// about static files or SPA fallback.
//
//   POST /api/auth/signup
//   POST /api/auth/login
//   GET  /api/auth/me
//   POST /api/auth/logout
//   POST /api/keys/publish
//   GET  /api/keys/bundle/:username
//   GET  /ws            (WebSocket upgrade -> the caller's mailbox DO)

import {
	bumpTokenEpoch,
	checkRateLimit,
	clearTotp,
	createUser,
	getRecoveryParams,
	getUser,
	setBackupCodeHashes,
	setRecovery,
	setTotp,
	setTotpLastStep,
	setUserSealToken,
	updatePassword,
	type UserRow,
} from './db';
import { decryptTotpSecret, encryptTotpSecret, hashBackupCode, verifyTotp } from './totp';

// Auth rate limits. Keyed by the TARGET username, not an IP — FlatFold
// deliberately does not log IPs (invariant #5), so per-actor throttling isn't
// possible; per-username is. Tradeoff: a short, generous window means a legit
// user won't hit it, an online password-guessing attack is throttled to ~10
// tries / 5 min, and the worst an attacker can do to a victim is a ~5-minute
// login lockout. Cross-username signup spam requires IP limiting we don't do —
// documented in THREAT_MODEL.md.
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_SECONDS = 300;
const SIGNUP_LIMIT = 5;
const SIGNUP_WINDOW_SECONDS = 3600;
// M3: per-user media-upload rate limit. Each object is capped at 25 MiB, so an
// authed user could otherwise write unbounded blobs to R2. The deploy-time R2
// lifecycle TTL remains the backstop for cleanup.
const MEDIA_UPLOAD_LIMIT = 20;
const MEDIA_UPLOAD_WINDOW_SECONDS = 60;

function rateLimitWindow(windowSeconds: number): number {
	return Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
}
import {
	buildClearSessionCookie,
	buildSessionCookie,
	hashPassword,
	isNativeClient,
	isValidPassword,
	isValidUsername,
	readBearerToken,
	readSessionCookie,
	signSessionToken,
	verifyPassword,
	verifySessionPayload,
	WS_ECHO_SUBPROTOCOL,
} from './auth';
import { handleGetBundle, handlePublishKeys } from './keys';
import { handleMediaDelete, handleMediaDownload, handleMediaUpload } from './media';
import { handlePushSubscribe, handlePushUnsubscribe, handleVapidPublicKey, handleApnsSubscribe, handleApnsUnsubscribe } from './push';
import { handleDeleteAccount } from './account';
import { handleSeal, handleSealKeys } from './seal';

export { Mailbox } from './mailbox';

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { 'Content-Type': 'application/json', ...init.headers },
	});
}

// CORS for native cross-origin callers (capacitor://localhost). Safe with a
// wildcard origin BECAUSE we never set Allow-Credentials: native authenticates
// with a bearer token, and the web cookie is SameSite=Strict so it never rides
// a cross-site request. So a cross-origin page can neither read a credentialed
// response nor borrow a victim's cookie — an unauthenticated caller just gets
// 401. Wildcard here does not widen the non-browser attack surface (any client
// can already call a public HTTPS endpoint; CORS only gates browser JS reads).
const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-FlatFold-Native',
	'Access-Control-Max-Age': '86400',
};

// Auth response: native gets the token in the BODY (the cross-origin cookie
// can't ride; a JS-readable token is native's only option and lives in the
// Keychain). Web gets the httpOnly cookie and NEVER the token in the body — XSS
// can't read a cookie but could read a response body.
//
// `native` is decided per-endpoint: login/signup have no incoming token, so
// they key on the `X-FlatFold-Native` header; authenticated endpoints (me)
// instead key on "did this request arrive via bearer?" — so a native client's
// sliding refresh never silently returns a Set-Cookie it can't use, even if it
// forgets the header.
function authResponse(body: Record<string, unknown>, token: string, native: boolean): Response {
	if (native) return json({ ...body, token });
	return json(body, { headers: { 'Set-Cookie': buildSessionCookie(token) } });
}

async function readAuthenticatedUsername(request: Request, env: Env): Promise<string | null> {
	// Bearer (native /api/* or /ws subprotocol) or the web session cookie —
	// both are the same signed token verified identically below.
	const token = readBearerToken(request) ?? readSessionCookie(request);
	if (!token) return null;
	const payload = await verifySessionPayload(token, env.SESSION_SECRET);
	if (!payload) return null;
	// L3: revocation check — the token's epoch must still match the user's current
	// token_epoch. A "Sign out everywhere" (or a deleted account) fails this.
	const user = await getUser(env.DB, payload.sub);
	if (!user || user.token_epoch !== payload.epoch) return null;
	return payload.sub;
}

async function handleSignup(request: Request, env: Env): Promise<Response> {
	const body = await request.json().catch(() => null);
	const username = (body as { username?: unknown } | null)?.username;
	const password = (body as { password?: unknown } | null)?.password;

	if (!isValidUsername(username)) {
		return json({ error: 'Username must be 3-32 characters: letters, numbers, underscore.' }, { status: 400 });
	}
	if (!isValidPassword(password)) {
		return json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
	}

	const window = rateLimitWindow(SIGNUP_WINDOW_SECONDS);
	if (!(await checkRateLimit(env.DB, `signup:${username}`, window, SIGNUP_LIMIT))) {
		return json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
	}

	const existing = await getUser(env.DB, username);
	if (existing) {
		return json({ error: 'That username is taken.' }, { status: 409 });
	}

	const passwordVerifier = await hashPassword(password);
	// Coarsened to the minute — see migrations/0001_init.sql.
	const createdAt = Math.floor(Date.now() / 60_000) * 60;
	await createUser(env.DB, { username, passwordVerifier, createdAt });

	const token = await signSessionToken(username, env.SESSION_SECRET, 0); // fresh user ⇒ epoch 0
	return authResponse({ username }, token, isNativeClient(request));
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
	const body = await request.json().catch(() => null);
	const username = (body as { username?: unknown } | null)?.username;
	const password = (body as { password?: unknown } | null)?.password;

	if (!isValidUsername(username) || !isValidPassword(password)) {
		// Generic failure — never distinguish "no such user" from "wrong
		// password" (no user-enumeration oracle).
		return json({ error: 'Invalid username or password.' }, { status: 401 });
	}

	// Throttle online password guessing (counts every attempt in the window).
	const window = rateLimitWindow(LOGIN_WINDOW_SECONDS);
	if (!(await checkRateLimit(env.DB, `login:${username}`, window, LOGIN_LIMIT))) {
		return json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
	}

	const user = await getUser(env.DB, username);
	const ok = user ? await verifyPassword(password, user.password_verifier) : false;
	if (!user || !ok) {
		return json({ error: 'Invalid username or password.' }, { status: 401 });
	}

	// Second factor (D7 §4): password alone isn't enough once 2FA is on. Ask for a
	// code, then verify it (TOTP or a single-use backup code) before issuing a token.
	if (user.totp_secret) {
		const code = (body as { code?: unknown } | null)?.code;
		if (typeof code !== 'string' || code.length === 0) {
			return json({ twoFactorRequired: true }, { status: 401 });
		}
		if (!(await checkRateLimit(env.DB, `2fa:${username}`, window, LOGIN_LIMIT))) {
			return json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
		}
		if (!(await verifyTwoFactor(env, user, code))) {
			return json({ error: 'Invalid code.', twoFactorRequired: true }, { status: 401 });
		}
	}

	const token = await signSessionToken(username, env.SESSION_SECRET, user.token_epoch);
	return authResponse({ username }, token, isNativeClient(request));
}

async function handleMe(request: Request, env: Env): Promise<Response> {
	const token = readBearerToken(request) ?? readSessionCookie(request);
	const payload = token ? await verifySessionPayload(token, env.SESSION_SECRET) : null;
	if (!payload) return json({ error: 'Not authenticated.' }, { status: 401 });
	// L3 revocation check + sliding refresh: reject a stale-epoch token, else
	// re-issue a fresh-expiry token carrying the SAME iat (preserves the
	// displayed sign-in time) and the current epoch. This slides the session on
	// each app open so a durable login never hits the idle wall.
	const user = await getUser(env.DB, payload.sub);
	if (!user || user.token_epoch !== payload.epoch) return json({ error: 'Not authenticated.' }, { status: 401 });
	const refreshed = await signSessionToken(payload.sub, env.SESSION_SECRET, user.token_epoch, payload.iat);
	return authResponse({ username: payload.sub, sessionCreatedAt: payload.iat }, refreshed, readBearerToken(request) !== null);
}

function handleLogout(): Response {
	return json({ ok: true }, { headers: { 'Set-Cookie': buildClearSessionCookie() } });
}

// L3 "Sign out everywhere": password-gated (a hijacked session must not be able
// to lock the real owner out or vice-versa), then bump the epoch to invalidate
// EVERY token including this device's. Mirrors the account-deletion re-auth.
async function handleLogoutAll(request: Request, env: Env, username: string): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
	const password = body?.password;
	if (typeof password !== 'string' || password.length === 0) {
		return json({ error: 'Password required.' }, { status: 400 });
	}
	const user = await getUser(env.DB, username);
	if (!user || !(await verifyPassword(password, user.password_verifier))) {
		return json({ error: 'Incorrect password.' }, { status: 401 });
	}
	await bumpTokenEpoch(env.DB, username);
	// Clear this device too — the bump already invalidated its (old-epoch) token.
	return json({ ok: true }, { headers: { 'Set-Cookie': buildClearSessionCookie() } });
}

// Change password (D7 §1): re-auth with the CURRENT password, store the new
// verifier + bump the epoch atomically (kills every other session), and hand back
// a fresh token at the NEW epoch so THIS session survives the change. The client
// has already staged the local keystore re-wrap durably; it finalizes that on our
// 2xx (rolls it back on our 4xx). Rate-limited so a hijacked session can't
// brute-force the current password to lock the real owner out.
async function handleChangePassword(request: Request, env: Env, username: string): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { current?: unknown; new?: unknown } | null;
	const current = body?.current;
	const next = body?.new;
	if (typeof current !== 'string' || current.length === 0) {
		return json({ error: 'Current password required.' }, { status: 400 });
	}
	if (!isValidPassword(next)) {
		return json({ error: 'New password must be at least 8 characters.' }, { status: 400 });
	}

	const window = rateLimitWindow(LOGIN_WINDOW_SECONDS);
	if (!(await checkRateLimit(env.DB, `changepw:${username}`, window, LOGIN_LIMIT))) {
		return json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
	}

	const user = await getUser(env.DB, username);
	if (!user || !(await verifyPassword(current, user.password_verifier))) {
		return json({ error: 'Incorrect password.' }, { status: 401 });
	}

	const newVerifier = await hashPassword(next);
	await updatePassword(env.DB, username, newVerifier); // verifier + epoch bump, atomic
	// Sign at the POST-bump epoch (user.token_epoch + 1) — signing at the old epoch
	// would hand back a token that's already stale against the row we just bumped.
	const token = await signSessionToken(username, env.SESSION_SECRET, user.token_epoch + 1);
	return authResponse({ ok: true }, token, isNativeClient(request));
}

// ---- TOTP two-factor (D7 §4) ----

// Verify a login's second factor: a TOTP code (advancing the replay counter) OR a
// single-use backup code (consumed). Returns whether it passed. A decrypt failure
// on the stored secret (e.g. SESSION_SECRET was rotated) falls through to backup
// codes rather than throwing.
async function verifyTwoFactor(env: Env, user: UserRow, code: string): Promise<boolean> {
	if (user.totp_secret) {
		try {
			const secret = await decryptTotpSecret(env.SESSION_SECRET, user.totp_secret);
			const step = await verifyTotp(secret, code, Date.now(), user.totp_last_step ?? Number.NEGATIVE_INFINITY);
			if (step !== null) {
				await setTotpLastStep(env.DB, user.username, step);
				return true;
			}
		} catch {
			// fall through to backup codes
		}
	}
	const hashes: string[] = user.backup_code_hashes ? (JSON.parse(user.backup_code_hashes) as string[]) : [];
	const h = await hashBackupCode(user.username, code);
	if (hashes.includes(h)) {
		await setBackupCodeHashes(env.DB, user.username, hashes.filter((x) => x !== h)); // single-use
		return true;
	}
	return false;
}

// Enable (or replace) TOTP. Password-reauthed — a hijacked session alone must not
// be able to plant a second factor the real owner doesn't hold (a lockout/DoS).
// The client proves the secret was scanned by including a current code, which we
// verify before storing the (encrypted) secret + hashed backup codes.
async function handleTwoFactorEnable(request: Request, env: Env, username: string): Promise<Response> {
	const body = (await request.json().catch(() => null)) as {
		password?: unknown;
		secret?: unknown;
		code?: unknown;
		backupCodes?: unknown;
	} | null;
	const { password, secret, code, backupCodes } = body ?? {};
	if (typeof password !== 'string' || typeof secret !== 'string' || typeof code !== 'string') {
		return json({ error: 'Malformed request.' }, { status: 400 });
	}
	if (!Array.isArray(backupCodes) || backupCodes.length === 0 || !backupCodes.every((c) => typeof c === 'string')) {
		return json({ error: 'Missing backup codes.' }, { status: 400 });
	}
	const user = await getUser(env.DB, username);
	if (!user || !(await verifyPassword(password, user.password_verifier))) {
		return json({ error: 'Incorrect password.' }, { status: 401 });
	}
	// Confirm the user actually enrolled the secret in their authenticator.
	if ((await verifyTotp(secret, code, Date.now())) === null) {
		return json({ error: 'That code didn’t match. Try the current one.' }, { status: 401 });
	}
	const encSecret = await encryptTotpSecret(env.SESSION_SECRET, secret);
	const backupHashes = await Promise.all((backupCodes as string[]).map((c) => hashBackupCode(username, c)));
	await setTotp(env.DB, username, { encSecret, backupHashes });
	return json({ ok: true });
}

// Disable TOTP. Requires the password AND a valid second factor (TOTP or a backup
// code) — so neither a hijacked session nor a known password alone can strip 2FA.
async function handleTwoFactorDisable(request: Request, env: Env, username: string): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { password?: unknown; code?: unknown } | null;
	const { password, code } = body ?? {};
	if (typeof password !== 'string' || typeof code !== 'string') {
		return json({ error: 'Password and a current code are required.' }, { status: 400 });
	}
	const user = await getUser(env.DB, username);
	if (!user || !(await verifyPassword(password, user.password_verifier))) {
		return json({ error: 'Incorrect password.' }, { status: 401 });
	}
	if (!user.totp_secret) return json({ ok: true }); // already off
	const window = rateLimitWindow(LOGIN_WINDOW_SECONDS);
	if (!(await checkRateLimit(env.DB, `2fa:${username}`, window, LOGIN_LIMIT))) {
		return json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
	}
	if (!(await verifyTwoFactor(env, user, code))) {
		return json({ error: 'That code isn’t right.' }, { status: 401 });
	}
	await clearTotp(env.DB, username);
	return json({ ok: true });
}

// ---- account recovery (D7 §3) ----

// Enroll (or replace) a recovery code. Password-reauthed (like logout-all /
// delete): a hijacked SESSION alone must not be able to plant a recovery backdoor
// or clobber the real owner's recovery. The uploaded blob is opaque ciphertext;
// `auth` is the recovery authenticator (hashed here, never stored in the clear).
async function handleRecoveryEnroll(request: Request, env: Env, username: string): Promise<Response> {
	const body = (await request.json().catch(() => null)) as {
		password?: unknown;
		saltRec?: unknown;
		saltAuth?: unknown;
		blob?: unknown;
		auth?: unknown;
	} | null;
	const { password, saltRec, saltAuth, blob, auth } = body ?? {};
	if (typeof password !== 'string' || password.length === 0) {
		return json({ error: 'Password required.' }, { status: 400 });
	}
	if ([saltRec, saltAuth, blob, auth].some((v) => typeof v !== 'string' || (v as string).length === 0)) {
		return json({ error: 'Malformed recovery enrollment.' }, { status: 400 });
	}
	const user = await getUser(env.DB, username);
	if (!user || !(await verifyPassword(password, user.password_verifier))) {
		return json({ error: 'Incorrect password.' }, { status: 401 });
	}
	await setRecovery(env.DB, username, {
		verifier: await hashPassword(auth as string),
		blob: blob as string,
		saltRec: saltRec as string,
		saltAuth: saltAuth as string,
	});
	return json({ ok: true });
}

// The PUBLIC recovery salts for a username (needed to re-derive the recovery keys
// on a new device). 404 when the user hasn't enrolled recovery. Salts aren't
// secret; username existence is already discoverable via signup.
async function handleRecoveryParams(request: Request, env: Env): Promise<Response> {
	const username = new URL(request.url).searchParams.get('username');
	if (!isValidUsername(username)) return json({ error: 'Invalid username.' }, { status: 400 });
	const params = await getRecoveryParams(env.DB, username);
	if (!params) return json({ error: 'No recovery code is set for this account.' }, { status: 404 });
	return json(params);
}

// Recover: authenticate with the recovery authenticator (derived from the code),
// set a NEW password, and return the opaque recovery blob so the client can
// rebuild its identity locally. One atomic step — the blob is released ONLY on a
// successful auth + reset. Rate-limited per username (offline-guess throttle);
// bumps the epoch (any lingering sessions die). New login is issued.
async function handleRecoveryReset(request: Request, env: Env): Promise<Response> {
	const body = (await request.json().catch(() => null)) as {
		username?: unknown;
		recAuth?: unknown;
		newPassword?: unknown;
	} | null;
	const { username, recAuth, newPassword } = body ?? {};
	if (!isValidUsername(username) || typeof recAuth !== 'string' || recAuth.length === 0) {
		return json({ error: 'Invalid recovery request.' }, { status: 400 });
	}
	if (!isValidPassword(newPassword)) {
		return json({ error: 'New password must be at least 8 characters.' }, { status: 400 });
	}

	const window = rateLimitWindow(LOGIN_WINDOW_SECONDS);
	if (!(await checkRateLimit(env.DB, `recovery:${username}`, window, LOGIN_LIMIT))) {
		return json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
	}

	const user = await getUser(env.DB, username);
	// Generic failure whether the account is missing, has no recovery, or the
	// authenticator is wrong — no oracle for which.
	if (!user || !user.recovery_verifier || !user.recovery_blob || !(await verifyPassword(recAuth, user.recovery_verifier))) {
		return json({ error: 'That recovery code isn’t right.' }, { status: 401 });
	}

	await updatePassword(env.DB, username, await hashPassword(newPassword)); // verifier + epoch bump, atomic
	const token = await signSessionToken(username, env.SESSION_SECRET, user.token_epoch + 1);
	return authResponse({ blob: user.recovery_blob }, token, isNativeClient(request));
}

async function handleWebSocketUpgrade(request: Request, env: Env): Promise<Response> {
	const username = await readAuthenticatedUsername(request, env);
	if (!username) return json({ error: 'Not authenticated.' }, { status: 401 });

	// Stamp a trusted header before forwarding into the DO. The DO can't
	// otherwise learn which user it's acting as (Durable Objects have no
	// public URL of their own here — they're only reachable via this
	// Worker's `env.MAILBOX.getByName()` call, so a header set at this one
	// trusted choke point can't be spoofed by the original client request).
	const headers = new Headers(request.headers);
	headers.set('X-Authenticated-User', username);
	// Don't leak the bearer token (smuggled as a `flatfold.bearer.<token>`
	// subprotocol offer) into the DO layer — the Worker already authenticated.
	// Keep only the benign `flatfold` marker so the DO can echo it in the 101.
	// Web (cookie path) offers no subprotocol, so this deletes the header.
	const offered = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((p) => p.trim());
	if (offered.includes(WS_ECHO_SUBPROTOCOL)) headers.set('Sec-WebSocket-Protocol', WS_ECHO_SUBPROTOCOL);
	else headers.delete('Sec-WebSocket-Protocol');
	const forwardedRequest = new Request(request, { headers });

	const stub = env.MAILBOX.getByName(username);
	return stub.fetch(forwardedRequest);
}

async function route(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;
		const { method } = request;

		if (pathname === '/ws') {
			return handleWebSocketUpgrade(request, env);
		}

		if (pathname === '/api/auth/signup' && method === 'POST') {
			return handleSignup(request, env);
		}
		if (pathname === '/api/auth/login' && method === 'POST') {
			return handleLogin(request, env);
		}
		if (pathname === '/api/auth/me' && method === 'GET') {
			return handleMe(request, env);
		}
		if (pathname === '/api/auth/logout' && method === 'POST') {
			return handleLogout();
		}
		if (pathname === '/api/auth/logout-all' && method === 'POST') {
			const username = await readAuthenticatedUsername(request, env);
			if (!username) return json({ error: 'Not authenticated.' }, { status: 401 });
			return handleLogoutAll(request, env, username);
		}
		if (pathname === '/api/auth/change-password' && method === 'POST') {
			const username = await readAuthenticatedUsername(request, env);
			if (!username) return json({ error: 'Not authenticated.' }, { status: 401 });
			return handleChangePassword(request, env, username);
		}
		if (pathname === '/api/auth/recovery/enroll' && method === 'POST') {
			const username = await readAuthenticatedUsername(request, env);
			if (!username) return json({ error: 'Not authenticated.' }, { status: 401 });
			return handleRecoveryEnroll(request, env, username);
		}
		// Recovery params + reset are DELIBERATELY unauthenticated — a forgotten
		// password means no session. Auth is the recovery authenticator itself.
		if (pathname === '/api/auth/recovery/params' && method === 'GET') {
			return handleRecoveryParams(request, env);
		}
		if (pathname === '/api/auth/recovery/reset' && method === 'POST') {
			return handleRecoveryReset(request, env);
		}
		if (pathname === '/api/auth/2fa/enable' && method === 'POST') {
			const username = await readAuthenticatedUsername(request, env);
			if (!username) return json({ error: 'Not authenticated.' }, { status: 401 });
			return handleTwoFactorEnable(request, env, username);
		}
		if (pathname === '/api/auth/2fa/disable' && method === 'POST') {
			const username = await readAuthenticatedUsername(request, env);
			if (!username) return json({ error: 'Not authenticated.' }, { status: 401 });
			return handleTwoFactorDisable(request, env, username);
		}

		// Sealed-sender OHTTP gateway (reached via a third-party relay that blinds
		// the client IP). `/api/seal` is deliberately UNAUTHENTICATED — the sender
		// is never identified. `register-token` IS authenticated (the owner tells
		// their own DO which delivery token to accept).
		if (pathname === '/api/seal/keys' && method === 'GET') {
			return handleSealKeys(env);
		}
		if (pathname === '/api/seal' && method === 'POST') {
			return handleSeal(request, env);
		}
		if (pathname === '/api/seal/register-token' && method === 'POST') {
			const username = await readAuthenticatedUsername(request, env);
			if (!username) return json({ error: 'Not authenticated.' }, { status: 401 });
			const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
			if (typeof body?.token !== 'string' || body.token.length < 16) {
				return json({ error: 'token must be a string of at least 16 characters.' }, { status: 400 });
			}
			// Single writer for my delivery token: the DO (authoritative validator
			// for incoming sealed sends) FIRST, then the D1 bundle copy (handed to
			// first-contacters) only if the DO accepted. This order is the
			// crash-safe one — a bundle token the DO rejects would break
			// first-contact, whereas a DO token not yet in the bundle just isn't
			// handed out yet.
			const doResp = await env.MAILBOX.getByName(username).fetch('https://internal/register-token', {
				method: 'POST',
				body: JSON.stringify({ token: body.token }),
			});
			if (!doResp.ok) return json({ error: 'Could not register token.' }, { status: 400 });
			await setUserSealToken(env.DB, username, body.token);
			return json({ ok: true });
		}

		// Account deletion (invariant #6). Auth-gated AND password-reauthed
		// inside the handler — a session cookie alone can't nuke the account.
		if (pathname === '/api/account' && method === 'DELETE') {
			const username = await readAuthenticatedUsername(request, env);
			if (!username) return json({ error: 'Not authenticated.' }, { status: 401 });
			return handleDeleteAccount(request, env, username);
		}

		if (pathname === '/api/keys/publish' && method === 'POST') {
			const username = await readAuthenticatedUsername(request, env);
			if (!username) return json({ error: 'Not authenticated.' }, { status: 401 });
			return handlePublishKeys(request, env, username);
		}

		const bundleMatch = /^\/api\/keys\/bundle\/([^/]+)$/.exec(pathname);
		if (bundleMatch && method === 'GET') {
			const username = await readAuthenticatedUsername(request, env);
			if (!username) return json({ error: 'Not authenticated.' }, { status: 401 });
			return handleGetBundle(env, username, decodeURIComponent(bundleMatch[1]));
		}

		// Encrypted media — all auth-gated. The id is a random UUID and the
		// content is ciphertext, so "any authenticated user may fetch any id"
		// is not a confidentiality issue (unguessable id, opaque bytes).
		if (pathname === '/api/media' && method === 'POST') {
			const username = await readAuthenticatedUsername(request, env);
			if (!username) return json({ error: 'Not authenticated.' }, { status: 401 });
			const mediaWindow = rateLimitWindow(MEDIA_UPLOAD_WINDOW_SECONDS);
			if (!(await checkRateLimit(env.DB, `media:${username}`, mediaWindow, MEDIA_UPLOAD_LIMIT))) {
				return json({ error: 'Too many uploads. Please slow down.' }, { status: 429 });
			}
			return handleMediaUpload(request, env);
		}
		const mediaMatch = /^\/api\/media\/([^/]+)$/.exec(pathname);
		if (mediaMatch) {
			const username = await readAuthenticatedUsername(request, env);
			if (!username) return json({ error: 'Not authenticated.' }, { status: 401 });
			const id = decodeURIComponent(mediaMatch[1]);
			if (method === 'GET') return handleMediaDownload(env, id);
			if (method === 'DELETE') return handleMediaDelete(env, id);
		}

		// Web Push. The VAPID public key is non-secret (any client needs it to
		// subscribe); subscribe/unsubscribe require auth.
		if (pathname === '/api/push/vapid-public-key' && method === 'GET') {
			return handleVapidPublicKey(env);
		}
		if (pathname === '/api/push/subscribe' && method === 'POST') {
			const username = await readAuthenticatedUsername(request, env);
			if (!username) return json({ error: 'Not authenticated.' }, { status: 401 });
			return handlePushSubscribe(request, env, username);
		}
		if (pathname === '/api/push/unsubscribe' && method === 'POST') {
			const username = await readAuthenticatedUsername(request, env);
			if (!username) return json({ error: 'Not authenticated.' }, { status: 401 });
			return handlePushUnsubscribe(request, env, username);
		}

		// APNs push (native iOS — no Service Worker, so no Web Push). Same
		// content-free wake-up; the device registers a token instead of an
		// endpoint. Both paths require auth.
		if (pathname === '/api/push/apns/subscribe' && method === 'POST') {
			const username = await readAuthenticatedUsername(request, env);
			if (!username) return json({ error: 'Not authenticated.' }, { status: 401 });
			return handleApnsSubscribe(request, env, username);
		}
		if (pathname === '/api/push/apns/unsubscribe' && method === 'POST') {
			const username = await readAuthenticatedUsername(request, env);
			if (!username) return json({ error: 'Not authenticated.' }, { status: 401 });
			return handleApnsUnsubscribe(request, env, username);
		}

		return json({ error: 'Not found.' }, { status: 404 });
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		// Native cross-origin preflight — answer it before routing.
		if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}
		const response = await route(request, env);
		// Let native (capacitor://localhost) read /api responses cross-origin.
		// /ws is not CORS-relevant (WS upgrades bypass CORS).
		if (url.pathname.startsWith('/api/')) {
			for (const [key, value] of Object.entries(CORS_HEADERS)) response.headers.set(key, value);
		}
		return response;
	},
} satisfies ExportedHandler<Env>;
