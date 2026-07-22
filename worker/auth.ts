// Username/password auth: Argon2id hashing (`worker-password-auth`, a Rust
// `password_auth` crate compiled to a *statically-imported* .wasm module)
// and a stateless, HMAC-signed session cookie.
//
// Why not hash-wasm (or any WASM lib that compiles at call time): workerd
// disallows dynamic `WebAssembly.compile()`/`instantiate()` on raw bytes —
// only WASM modules that are statically imported at build time (and thus
// precompiled by the bundler) may be instantiated at runtime. This is a
// platform-wide restriction, not a local-dev quirk, so it has to be solved
// at the architecture level rather than worked around for tests only.
//
// Note on the token format: this is deliberately NOT a general-purpose JWT.
// We control both the signer and the verifier, so there is no "alg"/header
// to negotiate (and no `alg:"none"`-style confusion to defend against) —
// just `base64url(payload).base64url(HMAC-SHA256(payload))`.
//
// Passwords also do double duty later: M2 derives the local IndexedDB
// keystore key from the same raw password, but with a SEPARATE salt/KDF —
// never reuse this auth derivation for that. M1 does nothing about this
// beyond not logging or persisting the raw password server-side.

import { hashPassword as argon2Hash, verifyPassword as argon2Verify } from 'worker-password-auth';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;

export function isValidUsername(value: unknown): value is string {
	return typeof value === 'string' && USERNAME_RE.test(value);
}

export function isValidPassword(value: unknown): value is string {
	// L4: cap the max length to bound Argon2 input (a huge password would make
	// hashPassword do unbounded work). 1024 is far above any real passphrase.
	return typeof value === 'string' && value.length >= MIN_PASSWORD_LENGTH && value.length <= MAX_PASSWORD_LENGTH;
}

// PHC-encoded Argon2id hash string (OWASP-recommended params, salt embedded
// by the crate) — this is the entire contents of `password_verifier`.
export async function hashPassword(password: string): Promise<string> {
	return argon2Hash(password);
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
	try {
		return await argon2Verify(password, encodedHash);
	} catch {
		// A malformed stored hash should fail closed, not throw past the caller.
		return false;
	}
}

// ---- session token ----

// L3: long idle lifetime, sliding. Safe now that token_epoch gives real
// server-side revocation ("Sign out everywhere" / password change bump the
// epoch and kill every token instantly). 14 days matches what people expect
// from a messenger and fixes the old "bounced to login after a few minutes"
// bug; a stolen token is bounded by the explicit kill switch, not a short TTL.
const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;
const COOKIE_NAME = 'ww_session';

interface TokenPayload {
	sub: string;
	iat: number;
	exp: number;
	// Session epoch this token was issued under (L3). Absent on pre-L3 tokens ⇒
	// treated as 0 (the default user epoch), so old sessions keep working.
	epoch: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function importHmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify',
	]);
}

// `epoch` is the user's current token_epoch (revocation). `iat` may be passed
// to PRESERVE the original sign-in time across a sliding refresh; omit it for a
// fresh sign-in.
export async function signSessionToken(username: string, secret: string, epoch: number, iat?: number): Promise<string> {
	const key = await importHmacKey(secret);
	const now = Math.floor(Date.now() / 1000);
	const payload: TokenPayload = { sub: username, iat: iat ?? now, exp: now + SESSION_TTL_SECONDS, epoch };
	const payloadB64 = base64urlEncode(textEncoder.encode(JSON.stringify(payload)));
	const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(payloadB64));
	return `${payloadB64}.${base64urlEncode(new Uint8Array(signature))}`;
}

// Returns the verified payload (or null). The narrower verifySessionToken
// below wraps this for the common "just the username" case.
export async function verifySessionPayload(token: string, secret: string): Promise<TokenPayload | null> {
	// The whole verify is fail-closed: ANY malformed token → null (→ 401), never
	// a throw. This matters now that clients can send an ARBITRARY bearer token —
	// `base64urlDecode`'s atob throws on a non-base64 signature (e.g. "not.a.token"),
	// which pre-bearer only the server-set (always-valid) cookie fed this, so the
	// throw used to be unreachable and surfaced as a 500.
	try {
		const [payloadB64, sigB64] = token.split('.');
		if (!payloadB64 || !sigB64) return null;

		const key = await importHmacKey(secret);
		const valid = await crypto.subtle.verify('HMAC', key, base64urlDecode(sigB64), textEncoder.encode(payloadB64));
		if (!valid) return null;

		const payload = JSON.parse(textDecoder.decode(base64urlDecode(payloadB64))) as TokenPayload;
		if (typeof payload.sub !== 'string' || payload.exp < Math.floor(Date.now() / 1000)) return null;
		// Normalize epoch: pre-L3 tokens have none ⇒ 0 (matches the default user epoch).
		if (typeof payload.epoch !== 'number') payload.epoch = 0;
		return payload;
	} catch {
		return null;
	}
}

export async function verifySessionToken(token: string, secret: string): Promise<string | null> {
	return (await verifySessionPayload(token, secret))?.sub ?? null;
}

// ---- native-client token delivery (Phase 1: native apps) ----
// Web authenticates with the httpOnly SameSite=Strict cookie below. Native
// clients (capacitor://localhost) are cross-origin — that cookie can't ride —
// so they signal themselves with this header, receive the token in the response
// BODY, and return it as `Authorization: Bearer`. `Origin` is deliberately NOT
// the signal: this selects RESPONSE FORMAT only (cookie vs body), never
// authorization, so a spoofed value gains nothing — every path still requires
// valid credentials. Never promote this into an auth decision.
export const NATIVE_CLIENT_HEADER = 'X-FlatFold-Native';

export function isNativeClient(request: Request): boolean {
	return request.headers.get(NATIVE_CLIENT_HEADER) !== null;
}

// The subprotocol prefix native smuggles the token under on /ws. The in-webview
// JS `new WebSocket(url, protocols)` constructor can't set request headers, but
// its `protocols` argument becomes the `Sec-WebSocket-Protocol` header — the one
// channel the Worker CAN read at upgrade time, which it must, to route the
// socket to the per-user mailbox DO (`getByName(username)`) before any frame is
// exchanged. The token charset (base64url + '.') is all valid RFC 6455 tokens.
export const WS_BEARER_PREFIX = 'flatfold.bearer.';
// The benign subprotocol the client also offers and the server echoes in the
// 101 (some WebKit builds fail the handshake if the server selects none).
export const WS_ECHO_SUBPROTOCOL = 'flatfold';

// A bearer token from `Authorization: Bearer …` (/api/*) or a
// `flatfold.bearer.<token>` subprotocol offer (/ws). Null if neither is present.
export function readBearerToken(request: Request): string | null {
	const authz = request.headers.get('Authorization');
	if (authz && authz.startsWith('Bearer ')) {
		const token = authz.slice('Bearer '.length).trim();
		if (token) return token;
	}
	const protocols = request.headers.get('Sec-WebSocket-Protocol');
	if (protocols) {
		for (const raw of protocols.split(',')) {
			const p = raw.trim();
			if (p.startsWith(WS_BEARER_PREFIX)) return p.slice(WS_BEARER_PREFIX.length);
		}
	}
	return null;
}

// ---- cookie plumbing ----
// httpOnly + Secure + SameSite=Strict: a browser WebSocket constructor can't
// set an Authorization header, so a cookie is the one mechanism that
// authenticates both /api/* and the /ws handshake on a same-origin SPA,
// without ever putting the token in a URL or query string.

export function buildSessionCookie(token: string): string {
	return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function buildClearSessionCookie(): string {
	return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export function readSessionCookie(request: Request): string | null {
	const header = request.headers.get('Cookie');
	if (!header) return null;
	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq === -1) continue;
		const key = part.slice(0, eq).trim();
		if (key === COOKIE_NAME) return part.slice(eq + 1).trim();
	}
	return null;
}

// ---- base64url helpers (WebCrypto has no built-in base64url codec) ----

function base64urlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(value: string): Uint8Array {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
