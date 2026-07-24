// D7 Phase 0 — the identity-record seal/open/migrate logic (pure crypto, no
// IndexedDB). A v2 record wraps a master key (MK) under a password-derived key
// and encrypts the identity doc under MK. Legacy v1 records (password-derived
// key encrypts the doc directly) migrate to v2 on open by ADOPTING that derived
// key AS the MK — so no store is ever re-encrypted (the blob is unchanged).
//
// Runs under the jsdom project because deriveKeystoreKey uses hash-wasm
// (Argon2id), which workerd forbids.
import { describe, expect, it } from 'vitest';
import {
	sealIdentityRecord,
	openIdentityRecord,
	WrongPasswordError,
	type IdentityRecordV1,
	type IdentityRecordV2,
} from '../src/keystore/identityRecord';
import { deriveKeystoreKey, encryptBlob, generateKeystoreSalt, generateMasterKey } from '../src/keystore/crypto';

const DOC = { hello: 'world', n: 42 };

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Build a legacy v1 record the OLD way: the password-derived key encrypts the
// doc directly, salt stored alongside.
async function makeV1(password: string): Promise<{ record: IdentityRecordV1; derivedKey: Uint8Array }> {
	const salt = generateKeystoreSalt();
	const derivedKey = await deriveKeystoreKey(password, salt);
	return { record: { salt, blob: encryptBlob(derivedKey, DOC) }, derivedKey };
}

describe('sealIdentityRecord / openIdentityRecord (v2)', () => {
	it('round-trips the doc and master key', async () => {
		const mk = generateMasterKey();
		const record = await sealIdentityRecord(DOC, 'correct horse', mk);
		expect(record.version).toBe(2);
		const opened = await openIdentityRecord<typeof DOC>(record, 'correct horse');
		expect(opened.doc).toEqual(DOC);
		expect(bytesEqual(opened.masterKey, mk)).toBe(true);
		expect(opened.migrated).toBeUndefined();
	});

	it('throws WrongPasswordError on a bad password', async () => {
		const record = await sealIdentityRecord(DOC, 'right', generateMasterKey());
		await expect(openIdentityRecord(record, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError);
	});
});

describe('openIdentityRecord — legacy v1 migration', () => {
	it('opens a v1 record and adopts the derived key as the master key', async () => {
		const { record, derivedKey } = await makeV1('pw');
		const opened = await openIdentityRecord<typeof DOC>(record, 'pw');
		expect(opened.doc).toEqual(DOC);
		// MK for a migrated user IS the old derived key — so its stores (already
		// encrypted under that key) need no re-encryption.
		expect(bytesEqual(opened.masterKey, derivedKey)).toBe(true);
	});

	it('returns a v2 migrated record whose blob is UNCHANGED (no re-encryption)', async () => {
		const { record } = await makeV1('pw');
		const opened = await openIdentityRecord<typeof DOC>(record, 'pw');
		expect(opened.migrated).toBeDefined();
		expect((opened.migrated as IdentityRecordV2).version).toBe(2);
		expect(opened.migrated!.blob).toEqual(record.blob); // same ciphertext, not re-encrypted
	});

	it('the migrated v2 record re-opens to the same doc + master key', async () => {
		const { record } = await makeV1('pw');
		const first = await openIdentityRecord<typeof DOC>(record, 'pw');
		const second = await openIdentityRecord<typeof DOC>(first.migrated!, 'pw');
		expect(second.doc).toEqual(DOC);
		expect(bytesEqual(second.masterKey, first.masterKey)).toBe(true);
		expect(second.migrated).toBeUndefined(); // already v2
	});

	it('throws WrongPasswordError on a bad password (no migration)', async () => {
		const { record } = await makeV1('pw');
		await expect(openIdentityRecord(record, 'nope')).rejects.toBeInstanceOf(WrongPasswordError);
	});
});
