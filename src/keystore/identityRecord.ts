// The persisted identity-record envelope + its seal/open/migrate logic.
//
// PURE crypto — no IndexedDB (so it's unit-testable directly). index.ts wires
// these into createIdentity / unlock with the storage layer.
//
// A v2 record introduces a keystore master key (MK): MK encrypts every store,
// and MK itself is AEAD-wrapped in the record under a password-derived key
// (`wrap`). A credential change is then a cheap re-wrap of MK, not a
// re-encryption of every store. See docs/redesign/D7_IMPLEMENTATION_PLAN.md §0.
//
// Legacy v1 records (the password-derived key encrypted the doc directly)
// migrate on open by ADOPTING that derived key as the MK: the stores are already
// encrypted under it, so nothing is re-encrypted — we only add the wrap layer.
//
// Change-password is a TWO-WRAP operation (D7 §1). Because the local record and
// the server verifier are independent stores, a naive re-wrap has a crash window
// that can lock the user out: if the server accepts the new password but the app
// dies before the local record is rewritten, the new password logs in yet can't
// unlock the old wrap. The fix: `stageRewrap` writes a SECOND wrap (`altWrap`, MK
// under the new password) alongside the primary and that record is persisted
// BEFORE the server call. While staged, the record opens with EITHER password —
// so whichever side of the change the server ends up on, MK is still reachable.
// `openIdentityRecord` collapses a two-wrap record back to the single wrap the
// password actually opened (via `migrated`), so once the change settles the stale
// password stops working. `promoteRewrap`/`abortRewrap` settle it explicitly on
// the happy path (server 2xx → promote to the new wrap; failure → abort to old).
import { deriveKeystoreKey, encryptBlob, decryptBlob, generateKeystoreSalt, wrapKey, unwrapKey, type EncryptedBlob } from './crypto';

export interface IdentityRecordV1 {
	salt: string; // Argon2id salt; the derived key encrypts `blob` directly
	blob: EncryptedBlob;
}

export interface IdentityRecordV2 {
	version: 2;
	salt: string; // Argon2id salt for password -> primary wrapping key
	wrap: EncryptedBlob; // MK wrapped under the primary wrapping key
	blob: EncryptedBlob; // identity doc encrypted under MK
	// Optional SECOND wrap, present ONLY while a change-password is mid-flight:
	// MK wrapped under the NEW password (own salt). Kept durable before the server
	// call so a crash on either side of the change still leaves MK unlockable.
	// Collapsed away by openIdentityRecord once one password proves out.
	altSalt?: string;
	altWrap?: EncryptedBlob;
}

export type StoredIdentityRecord = IdentityRecordV1 | IdentityRecordV2;

export class WrongPasswordError extends Error {
	constructor() {
		super('wrong password');
		this.name = 'WrongPasswordError';
	}
}

function isV2(record: StoredIdentityRecord): record is IdentityRecordV2 {
	return (record as IdentityRecordV2).version === 2;
}

// A clean single-wrap v2 record (drops any staged alt wrap).
function singleWrap(salt: string, wrap: EncryptedBlob, blob: EncryptedBlob): IdentityRecordV2 {
	return { version: 2, salt, wrap, blob };
}

// Try to unwrap MK with `password` against a specific salt+wrap. Null on a tag
// mismatch (wrong password / tampered wrap) — never throws.
async function tryUnwrap(password: string, salt: string, wrap: EncryptedBlob): Promise<Uint8Array | null> {
	const key = await deriveKeystoreKey(password, salt);
	try {
		return unwrapKey(key, wrap);
	} catch {
		return null;
	}
}

// Seal a doc into a v2 record: fresh wrap salt, wrap MK under the derived key,
// encrypt the doc under MK.
export async function sealIdentityRecord<T extends object>(
	doc: T,
	password: string,
	masterKey: Uint8Array
): Promise<IdentityRecordV2> {
	const salt = generateKeystoreSalt();
	const wrappingKey = await deriveKeystoreKey(password, salt);
	return { version: 2, salt, wrap: wrapKey(wrappingKey, masterKey), blob: encryptBlob(masterKey, doc) };
}

// Open a v1 or v2 record with the password. Returns the doc + MK. `migrated` (a
// v2 record the caller should persist) is set when opening rewrote the record:
//   • a v1 record migrated to v2 (adopt the derived key as MK; blob unchanged), or
//   • a mid-change two-wrap record collapsed to the single wrap this password
//     opened (dropping the stale wrap — so the other password stops working).
// Throws WrongPasswordError when no wrap opens.
export async function openIdentityRecord<T>(
	record: StoredIdentityRecord,
	password: string
): Promise<{ doc: T; masterKey: Uint8Array; migrated?: IdentityRecordV2 }> {
	if (isV2(record)) {
		// Primary wrap first, then the staged alt wrap (if any).
		let masterKey = await tryUnwrap(password, record.salt, record.wrap);
		const openedViaPrimary = masterKey !== null;
		if (!masterKey && record.altSalt && record.altWrap) {
			masterKey = await tryUnwrap(password, record.altSalt, record.altWrap);
		}
		if (!masterKey) throw new WrongPasswordError();

		let migrated: IdentityRecordV2 | undefined;
		if (record.altWrap) {
			// Collapse to the wrap that opened, discarding the other.
			migrated = openedViaPrimary
				? singleWrap(record.salt, record.wrap, record.blob)
				: singleWrap(record.altSalt!, record.altWrap, record.blob);
		}
		return { doc: decryptBlob<T>(masterKey, record.blob), masterKey, migrated };
	}

	// v1: the password-derived key encrypts the doc directly. Adopt it as the MK
	// (the stores are already encrypted under it) and add the wrap layer.
	const derivedKey = await deriveKeystoreKey(password, record.salt);
	let doc: T;
	try {
		doc = decryptBlob<T>(derivedKey, record.blob);
	} catch {
		throw new WrongPasswordError();
	}
	const masterKey = derivedKey;
	const salt = generateKeystoreSalt();
	const wrappingKey = await deriveKeystoreKey(password, salt);
	const migrated = singleWrap(salt, wrapKey(wrappingKey, masterKey), record.blob);
	return { doc, masterKey, migrated };
}

// Stage a change-password: prove the current password (unwrap MK), then add a
// SECOND wrap of MK under the new password. The returned record opens with EITHER
// password and MUST be persisted before the server is told. The identity doc
// ciphertext is untouched — only a wrap is added. Throws WrongPasswordError if
// the current password is wrong (nothing is staged).
export async function stageRewrap(
	record: StoredIdentityRecord,
	currentPassword: string,
	newPassword: string
): Promise<IdentityRecordV2> {
	const opened = await openIdentityRecord<unknown>(record, currentPassword);
	// The clean single-wrap base under the current password: a v1 record migrates,
	// an already-staged record collapses — both surface as `migrated`; a clean v2
	// is itself the base.
	const base: IdentityRecordV2 = opened.migrated ?? (record as IdentityRecordV2);
	const altSalt = generateKeystoreSalt();
	const altWrap = wrapKey(await deriveKeystoreKey(newPassword, altSalt), opened.masterKey);
	return { version: 2, salt: base.salt, wrap: base.wrap, blob: base.blob, altSalt, altWrap };
}

// Settle a staged change after the server ACCEPTED it: the new password's wrap
// becomes the sole wrap; the old one is dropped. Idempotent on an unstaged record.
export function promoteRewrap(record: IdentityRecordV2): IdentityRecordV2 {
	if (!record.altSalt || !record.altWrap) return singleWrap(record.salt, record.wrap, record.blob);
	return singleWrap(record.altSalt, record.altWrap, record.blob);
}

// Settle a staged change after the server REJECTED it: drop the staged new wrap,
// keeping the old password. Idempotent on an unstaged record.
export function abortRewrap(record: IdentityRecordV2): IdentityRecordV2 {
	return singleWrap(record.salt, record.wrap, record.blob);
}
