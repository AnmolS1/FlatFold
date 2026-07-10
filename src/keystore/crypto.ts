// Password -> keystore key derivation (Argon2id via hash-wasm) and the
// AEAD envelope used to encrypt everything this module persists to
// IndexedDB.
//
// hash-wasm compiles its WASM module dynamically at call time. That's
// exactly the pattern that fails in workerd ("Wasm code generation
// disallowed by embedder" — see worker/auth.ts) but browsers impose no such
// restriction; the restriction is workerd-specific, not universal. This
// file must stay client-only — never imported from worker/ or shared/, or
// a build that bundles it for the Worker resurrects that exact failure.
//
// Deliberately a SEPARATE derivation from the server-side password check
// (worker/auth.ts, a different Argon2id call with its own salt). Per the
// rebuild brief: "never reuse the auth derivation."

import { argon2id } from 'hash-wasm';
import { aeadDecrypt, aeadEncrypt, randomBytes } from '../crypto/primitives';
import { base64ToBytes, bytesToBase64 } from './codec';

const KEYSTORE_INFO_SALT_LENGTH = 16;
const KEYSTORE_KEY_LENGTH = 32;

// Argon2id params. m=19456 KiB (19 MiB), t=2, p=1 is one of OWASP's five
// current recommended configurations (their stated MINIMUM) — verified against
// the OWASP Password Storage Cheat Sheet on 2026-07-06:
// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
// (options: 46 MiB/t=1, 19 MiB/t=2, 12 MiB/t=3, 9 MiB/t=4, 7 MiB/t=5 — equal defense).
// L7 residual: this key protects identity keys AT REST against offline brute-force
// of a min-8-char password, so raising to the 46 MiB/t=1 option is worth
// considering — but it requires a keystore-version migration (existing users'
// keys were derived at 19 MiB/t=2; changing params without versioning breaks
// unlock). Left as a decision for Anmol; see docs/SECURITY_AUDIT.md (L7).
const ARGON2ID_PARAMS = { parallelism: 1, iterations: 2, memorySize: 19_456 };

export function generateKeystoreSalt(): string {
	return bytesToBase64(randomBytes(KEYSTORE_INFO_SALT_LENGTH));
}

export async function deriveKeystoreKey(password: string, saltBase64: string): Promise<Uint8Array> {
	const hash = await argon2id({
		password,
		salt: base64ToBytes(saltBase64),
		...ARGON2ID_PARAMS,
		hashLength: KEYSTORE_KEY_LENGTH,
		outputType: 'binary',
	});
	return hash;
}

export interface EncryptedBlob {
	nonce: string; // base64, fresh per encryption
	ciphertext: string; // base64
}

export function encryptBlob(key: Uint8Array, plaintext: object): EncryptedBlob {
	const nonce = randomBytes(12);
	const bytes = new TextEncoder().encode(JSON.stringify(plaintext));
	const ciphertext = aeadEncrypt(key, nonce, bytes);
	return { nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(ciphertext) };
}

// Throws if `key` is wrong (AEAD tag mismatch) — callers use that to
// distinguish "wrong password" from "no local record".
export function decryptBlob<T>(key: Uint8Array, blob: EncryptedBlob): T {
	const plaintext = aeadDecrypt(key, base64ToBytes(blob.nonce), base64ToBytes(blob.ciphertext));
	return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
