// The persisted identity-record envelope + its seal/open/migrate logic.
//
// PURE crypto — no IndexedDB (so it's unit-testable directly). index.ts wires
// these into createIdentity / unlock with the storage layer.
//
// A v2 record introduces a keystore master key (MK): MK encrypts every store,
// and MK itself is AEAD-wrapped under a password-derived key (`wrap`). A
// credential change is then a cheap re-wrap of MK, not a re-encryption of every
// store. See docs/redesign/D7_IMPLEMENTATION_PLAN.md §0.
//
// Legacy v1 records (the password-derived key encrypted the doc directly)
// migrate on open by ADOPTING that derived key as the MK: the stores are already
// encrypted under it, so nothing is re-encrypted — we only add the wrap layer.
import { EncryptedBlob, deriveKeystoreKey, encryptBlob, decryptBlob, generateKeystoreSalt, wrapKey, unwrapKey } from './crypto';

export interface IdentityRecordV1 {
	salt: string; // Argon2id salt; the derived key encrypts `blob` directly
	blob: EncryptedBlob;
}

export interface IdentityRecordV2 {
	version: 2;
	salt: string; // Argon2id salt for password -> wrapping key
	wrap: EncryptedBlob; // MK wrapped under the wrapping key
	blob: EncryptedBlob; // identity doc encrypted under MK
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

// Open a v1 or v2 record with the password. Returns the doc + MK. For a v1
// record also returns `migrated` — the v2 record the caller should persist
// (same MK, same blob, added wrap). Throws WrongPasswordError on a bad password.
export async function openIdentityRecord<T>(
	record: StoredIdentityRecord,
	password: string
): Promise<{ doc: T; masterKey: Uint8Array; migrated?: IdentityRecordV2 }> {
	if (isV2(record)) {
		const wrappingKey = await deriveKeystoreKey(password, record.salt);
		let masterKey: Uint8Array;
		try {
			masterKey = unwrapKey(wrappingKey, record.wrap);
		} catch {
			throw new WrongPasswordError();
		}
		return { doc: decryptBlob<T>(masterKey, record.blob), masterKey };
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
	const migrated: IdentityRecordV2 = { version: 2, salt, wrap: wrapKey(wrappingKey, masterKey), blob: record.blob };
	return { doc, masterKey, migrated };
}
