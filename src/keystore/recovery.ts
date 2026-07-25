// D7 Phase 2 — recovery-code crypto (PURE, no IndexedDB). A user-held recovery
// code is the only way back into an account whose password is forgotten, without
// the server ever being able to hand out access. See
// docs/redesign/D7_account_recovery_design.md §3.
//
// The code is a 12-word BIP39 mnemonic (128-bit entropy + checksum — the
// checksum catches transcription errors when the user types it back). From it we
// derive TWO independent keys off SEPARATE salts:
//   • K_rec = Argon2id(entropy, salt_rec)  — wraps the backup secret (the opaque
//     recovery blob the server stores but can't read).
//   • recAuth = Argon2id(entropy, salt_auth) — the authenticator sent to the
//     server to prove ownership before it releases the blob. The server stores
//     only hashPassword(recAuth). Because the salts differ, recAuth is NOT K_rec,
//     so the server can hold recAuth yet never unwrap the blob → zero-knowledge.
//
// Derivations key off the code's canonical ENTROPY (not the raw typed string),
// so they're invariant to the case/spacing a user might type.
//
// Client-only (hash-wasm Argon2id): never import from worker/ or shared/.
import { generateMnemonic, validateMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { deriveKeystoreKey, generateKeystoreSalt, wrapKey, unwrapKey, type EncryptedBlob } from './crypto';
import { bytesToBase64 } from './codec';

const RECOVERY_STRENGTH_BITS = 128; // → 12 words

export class InvalidRecoveryCodeError extends Error {
	constructor() {
		super('invalid recovery code');
		this.name = 'InvalidRecoveryCodeError';
	}
}

// A fresh 12-word recovery code (128-bit + checksum). Shown to the user once.
export function generateRecoveryCode(): string {
	return generateMnemonic(wordlist, RECOVERY_STRENGTH_BITS);
}

// Canonicalize typed input (trim, lowercase, collapse inner whitespace) and
// validate the BIP39 checksum. Throws InvalidRecoveryCodeError on a bad code.
export function normalizeRecoveryCode(input: string): string {
	const canonical = input.trim().toLowerCase().split(/\s+/).join(' ');
	if (!validateMnemonic(canonical, wordlist)) throw new InvalidRecoveryCodeError();
	return canonical;
}

// The canonical entropy bytes underlying a code, base64-encoded — the KDF input,
// so derivations don't depend on how the user spaced/cased the words. Throws on
// an invalid code.
function codeKdfInput(code: string): string {
	return bytesToBase64(mnemonicToEntropy(normalizeRecoveryCode(code), wordlist));
}

// The wrapping key for the recovery blob (own salt).
export async function deriveRecoveryWrapKey(code: string, saltRec: string): Promise<Uint8Array> {
	return deriveKeystoreKey(codeKdfInput(code), saltRec);
}

// The authenticator sent to the server (own salt), base64. The server stores
// hashPassword(this); it is never the wrapping key.
export async function deriveRecoveryAuth(code: string, saltAuth: string): Promise<string> {
	return bytesToBase64(await deriveKeystoreKey(codeKdfInput(code), saltAuth));
}

export interface RecoveryEnrollment {
	saltRec: string;
	saltAuth: string;
	blob: EncryptedBlob; // `secret` wrapped under K_rec
	auth: string; // recAuth (base64); the server stores hashPassword(auth)
}

// Build the enrollment payload from a freshly generated code: wrap `secret` under
// a fresh K_rec and derive a fresh authenticator. `secret` is the bytes to back
// up (Phase 2b: the MK-independent identity payload).
export async function buildRecoveryEnrollment(code: string, secret: Uint8Array): Promise<RecoveryEnrollment> {
	const saltRec = generateKeystoreSalt();
	const saltAuth = generateKeystoreSalt();
	const [wrappingKey, auth] = await Promise.all([deriveRecoveryWrapKey(code, saltRec), deriveRecoveryAuth(code, saltAuth)]);
	return { saltRec, saltAuth, blob: wrapKey(wrappingKey, secret), auth };
}

// Recover the backed-up secret from a code + the stored salt + blob. Throws
// InvalidRecoveryCodeError on a wrong code or a tampered blob (AEAD tag mismatch).
export async function openRecoveryBlob(code: string, saltRec: string, blob: EncryptedBlob): Promise<Uint8Array> {
	const wrappingKey = await deriveRecoveryWrapKey(code, saltRec);
	try {
		return unwrapKey(wrappingKey, blob);
	} catch {
		throw new InvalidRecoveryCodeError();
	}
}
