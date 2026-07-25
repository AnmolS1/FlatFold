// D7 Phase 3 — server-side TOTP (RFC 6238) verification, at-rest secret
// encryption, and backup-code hashing. Runs in workerd, so it uses WebCrypto
// (crypto.subtle) throughout — HMAC-SHA1 for TOTP, AES-GCM for the at-rest
// secret, SHA-256 for backup-code hashes. No hash-wasm here (that's client-only).
import { base32, base64 } from '@scure/base';

const DIGITS = 6;
const PERIOD_SECONDS = 30;
// Domain-separated label so the at-rest key can never collide with any other use
// of SESSION_SECRET (which also signs session tokens).
const AT_REST_INFO = 'flatfold-totp-at-rest-v1';

// The 30-second time step a timestamp falls in.
export function totpStep(nowMs: number): number {
	return Math.floor(nowMs / 1000 / PERIOD_SECONDS);
}

function counterBytes(counter: number): Uint8Array {
	const buf = new Uint8Array(8);
	let c = counter;
	for (let i = 7; i >= 0; i--) {
		buf[i] = c & 0xff;
		c = Math.floor(c / 256);
	}
	return buf;
}

async function hmacSha1(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
	const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
	return new Uint8Array(await crypto.subtle.sign('HMAC', k, msg));
}

// The RFC 6238 code for a given secret + step (6 digits, dynamic truncation).
export async function computeTotp(secret: Uint8Array, counter: number): Promise<string> {
	const hs = await hmacSha1(secret, counterBytes(counter));
	const offset = hs[hs.length - 1] & 0x0f;
	const bin = ((hs[offset] & 0x7f) << 24) | (hs[offset + 1] << 16) | (hs[offset + 2] << 8) | hs[offset + 3];
	return (bin % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

// Verify a code against the ±1-step window (tolerates one period of clock skew).
// Returns the matched step (so the caller can persist it as a replay high-water
// mark) or null. `afterStep` rejects any step at or before a previously-used one
// — RFC 6238 §5.2 single-use. Only the TOTP path passes afterStep; backup codes
// never touch it.
export async function verifyTotp(
	secretBase32: string,
	code: string,
	nowMs: number,
	afterStep = Number.NEGATIVE_INFINITY
): Promise<number | null> {
	const trimmed = code.replace(/\s/g, '');
	if (!/^\d{6}$/.test(trimmed)) return null;
	const secret = base32.decode(secretBase32.toUpperCase());
	const current = totpStep(nowMs);
	for (const step of [current - 1, current, current + 1]) {
		if (step <= afterStep) continue; // replay guard
		if (timingSafeEqual(await computeTotp(secret, step), trimmed)) return step;
	}
	return null;
}

// ---- at-rest encryption of the shared secret ----
// Encrypt-at-rest so a D1 read alone can't downgrade a 2FA user to single-factor.
// The key is derived from SESSION_SECRET (HKDF, domain-separated) rather than a
// separate binding. TRADEOFF: rotating SESSION_SECRET makes every stored TOTP
// secret undecryptable — 2FA users then fall back to their (independently hashed)
// backup codes or re-enroll. Documented in migrations/0009 + THREAT_MODEL.

async function atRestKey(sessionSecret: string): Promise<CryptoKey> {
	const ikm = await crypto.subtle.importKey('raw', new TextEncoder().encode(sessionSecret), 'HKDF', false, ['deriveKey']);
	return crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(AT_REST_INFO) },
		ikm,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

export async function encryptTotpSecret(sessionSecret: string, secretBase32: string): Promise<string> {
	const key = await atRestKey(sessionSecret);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(secretBase32)));
	const packed = new Uint8Array(iv.length + ct.length);
	packed.set(iv, 0);
	packed.set(ct, iv.length);
	return base64.encode(packed);
}

export async function decryptTotpSecret(sessionSecret: string, stored: string): Promise<string> {
	const key = await atRestKey(sessionSecret);
	const packed = base64.decode(stored);
	const iv = packed.slice(0, 12);
	const ct = packed.slice(12);
	const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
	return new TextDecoder().decode(pt);
}

// ---- backup codes ----
// Normalize the same way the client formats them (see src/lib/totp.ts), so a
// hand-typed code with or without grouping matches what was stored.
export function normalizeBackupCode(code: string): string {
	return code.replace(/[\s-]/g, '').toUpperCase();
}

// A backup code is high-entropy (≥64-bit CSPRNG, pinned client-side), so a fast
// salted hash is sufficient — no need for Argon2id. Salted by username so equal
// codes across users don't collide to equal hashes.
export async function hashBackupCode(username: string, code: string): Promise<string> {
	const data = new TextEncoder().encode(`${username}:${normalizeBackupCode(code)}`);
	return base64.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}
