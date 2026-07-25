// WebAuthn PRF: the web counterpart of the iOS Secure-Enclave biometric unlock.
//
// The problem it solves: the Argon2-derived master key is held only in the JS
// heap (never sessionStorage), so every page reload asks for the password again.
// On iOS that friction is absorbed by Face ID, which releases MK from a
// biometry-gated Keychain item. The browser has no Keychain, so we use the
// WebAuthn PRF extension instead.
//
// How it works: a passkey with the `prf` extension can, on each successful
// assertion, deterministically derive a secret from a caller-supplied salt. That
// secret never leaves the authenticator and is only produced after a user
// verification gesture (Touch ID, Face ID, Windows Hello, a security key PIN).
// We HKDF it into a wrapping key and wrap MK with it. The wrapped MK sits in
// IndexedDB, useless to anyone who cannot make that authenticator produce the
// same PRF output.
//
// WHY THIS IS NOT A SOFT GATE: we are not asking WebAuthn "did the user
// authenticate?" and then handing over a key we already had — that would be the
// Model B design rejected for iOS, since the key would have to be readable at
// rest. Here the PRF output is a genuine cryptographic input: without the
// authenticator the wrap cannot be opened at all. No server is involved and no
// new trust is placed in one; the assertion is never sent anywhere, so a forged
// assertion buys nothing (it still wouldn't yield the right PRF output).
//
// The password always remains the ultimate secret. This is per-device
// convenience layered on top, exactly like the native biometric path.

const PRF_INFO = 'flatfold-passkey-unlock-v1';

/** Feature detection. PRF needs a platform authenticator and browser support. */
export function isPasskeyUnlockSupported(): boolean {
	return (
		typeof window !== 'undefined' &&
		typeof window.PublicKeyCredential !== 'undefined' &&
		typeof navigator !== 'undefined' &&
		typeof navigator.credentials?.create === 'function'
	);
}

/** Is a platform (built-in biometric) authenticator actually present? */
export async function hasPlatformAuthenticator(): Promise<boolean> {
	try {
		if (!isPasskeyUnlockSupported()) return false;
		return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
	} catch {
		return false;
	}
}

// WebAuthn's own `timeout` is only a hint, and browsers routinely ignore it for
// platform authenticators — a ceremony that never gets user activation can leave
// its promise pending forever, which reads to the user as a frozen button. Bound
// every call so failure is always visible and recoverable.
class WebAuthnTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms = 90_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new WebAuthnTimeoutError('The passkey prompt did not complete.')), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function randomBytes(n: number): Uint8Array {
	const b = new Uint8Array(n);
	crypto.getRandomValues(b);
	return b;
}

function toBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}
function fromBase64(s: string): Uint8Array {
	return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// The raw PRF output is already uniform, but run it through HKDF with a domain
// label anyway so this key can never collide with another use of the same
// credential's PRF on this origin.
async function derivePrfWrappingKey(prfOutput: ArrayBuffer, saltBytes: Uint8Array): Promise<Uint8Array> {
	const base = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: saltBytes as BufferSource,
			info: new TextEncoder().encode(PRF_INFO) as BufferSource,
		},
		base,
		256
	);
	return new Uint8Array(bits);
}

export interface PasskeyEnrollment {
	credentialId: string; // base64
	prfSalt: string; // base64 — the PRF input, stored so unlock can reproduce it
	wrappingKey: Uint8Array; // 32 bytes; the caller wraps MK with it and discards it
}

/**
 * Creates a passkey for this account and returns the wrapping key derived from
 * its PRF output. Returns null when PRF isn't available (unsupported browser or
 * authenticator), so the caller can simply not offer the feature.
 *
 * Two round trips by design: PRF results are not reliably returned at creation
 * time, so we create the credential and then immediately assert against it to
 * obtain the PRF output.
 */
export async function createPasskeyWrappingKey(username: string): Promise<PasskeyEnrollment | null> {
	if (!isPasskeyUnlockSupported()) return null;
	const prfSalt = randomBytes(32);

	const created = (await withTimeout(
		navigator.credentials.create({
			publicKey: {
				challenge: randomBytes(32) as BufferSource,
				rp: { name: 'FlatFold', id: window.location.hostname },
				user: {
					id: new TextEncoder().encode(username) as BufferSource,
					name: username,
					displayName: username,
				},
				pubKeyCredParams: [
					{ type: 'public-key', alg: -7 }, // ES256
					{ type: 'public-key', alg: -257 }, // RS256
				],
				authenticatorSelection: {
					authenticatorAttachment: 'platform',
					// 'preferred', not 'required': we store the credential id
					// ourselves, so a discoverable credential buys nothing and
					// 'required' needlessly fails on some authenticators.
					residentKey: 'preferred',
					userVerification: 'required', // the biometric gesture is the point
				},
				timeout: 60_000,
				// Ask for the PRF output DURING creation. This is the difference
				// between one Touch ID prompt and two: a second ceremony
				// immediately after create() has no user activation left, so the
				// browser may never show its prompt and the promise hangs.
				extensions: { prf: { eval: { first: prfSalt as BufferSource } } } as AuthenticationExtensionsClientInputs,
			},
		})
	)) as PublicKeyCredential | null;
	if (!created) return null;

	const ext = created.getClientExtensionResults() as {
		prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
	};
	const credentialId = new Uint8Array(created.rawId);

	// Happy path: the authenticator returned the PRF output straight away, so
	// enrollment is a single gesture.
	let prfOutput = ext.prf?.results?.first ?? null;

	if (!prfOutput) {
		// Some authenticators report `enabled` but withhold results until a real
		// assertion. That needs a SECOND ceremony, which may lack user activation
		// — so bound it and fail loudly instead of hanging. If PRF isn't supported
		// at all, bail now rather than leaving a credential that can never unlock.
		if (!ext.prf?.enabled) return null;
		prfOutput = await assertPrfOutput(credentialId, prfSalt);
		if (!prfOutput) return null;
	}

	return {
		credentialId: toBase64(credentialId),
		prfSalt: toBase64(prfSalt),
		wrappingKey: await derivePrfWrappingKey(prfOutput, prfSalt),
	};
}

/** Runs the assertion (prompting the biometric) and returns the raw PRF output. */
async function assertPrfOutput(credentialId: Uint8Array, prfSalt: Uint8Array): Promise<ArrayBuffer | null> {
	const assertion = (await withTimeout(
		navigator.credentials.get({
			publicKey: {
				challenge: randomBytes(32) as BufferSource,
				rpId: window.location.hostname,
				allowCredentials: [{ type: 'public-key', id: credentialId as BufferSource }],
				userVerification: 'required',
				timeout: 60_000,
				extensions: {
					prf: { eval: { first: prfSalt as BufferSource } },
				} as AuthenticationExtensionsClientInputs,
			},
		})
	)) as PublicKeyCredential | null;
	if (!assertion) return null;
	const results = (assertion.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results;
	return results?.first ?? null;
}

/**
 * Re-derives the wrapping key for an enrolled passkey. Prompts the biometric.
 * Returns null if the user cancels or PRF is unavailable — the caller falls back
 * to the password.
 */
export async function getPasskeyWrappingKey(credentialIdB64: string, prfSaltB64: string): Promise<Uint8Array | null> {
	if (!isPasskeyUnlockSupported()) return null;
	try {
		const prfSalt = fromBase64(prfSaltB64);
		const prfOutput = await assertPrfOutput(fromBase64(credentialIdB64), prfSalt);
		if (!prfOutput) return null;
		return await derivePrfWrappingKey(prfOutput, prfSalt);
	} catch {
		return null; // cancelled, timed out, or credential gone
	}
}
