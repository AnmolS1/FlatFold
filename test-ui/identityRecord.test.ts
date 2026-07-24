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
	stageRewrap,
	promoteRewrap,
	abortRewrap,
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

// Change password is a two-wrap operation: stageRewrap writes a SECOND wrap
// (MK under the NEW password) alongside the primary, so the record is durable
// on disk BEFORE the server is told. Whatever password the server ends up
// accepting can then still unlock locally — no crash window can lock the user
// out. openIdentityRecord opens via EITHER wrap and collapses the record back to
// a single wrap (dropping the stale one) so the old password stops working once
// the change settles.
describe('stageRewrap — the durable mid-change (two-wrap) record', () => {
	async function sealed(password: string): Promise<{ record: IdentityRecordV2; mk: Uint8Array }> {
		const mk = generateMasterKey();
		return { record: await sealIdentityRecord(DOC, password, mk), mk };
	}

	// THE discriminating test: a mid-change record must open with EITHER password,
	// because a crash can leave the server on either side of the change.
	it('opens with BOTH the old and the new password, yielding the same master key', async () => {
		const { record, mk } = await sealed('old-pw');
		const staged = await stageRewrap(record, 'old-pw', 'new-pw');

		const viaOld = await openIdentityRecord<typeof DOC>(staged, 'old-pw');
		const viaNew = await openIdentityRecord<typeof DOC>(staged, 'new-pw');
		expect(viaOld.doc).toEqual(DOC);
		expect(viaNew.doc).toEqual(DOC);
		expect(bytesEqual(viaOld.masterKey, mk)).toBe(true);
		expect(bytesEqual(viaNew.masterKey, mk)).toBe(true);
	});

	it('leaves the identity doc ciphertext UNCHANGED (only a wrap is added)', async () => {
		const { record } = await sealed('old-pw');
		const staged = await stageRewrap(record, 'old-pw', 'new-pw');
		expect(staged.blob).toEqual(record.blob);
		expect(staged.altWrap).toBeDefined();
		expect(staged.altSalt).toBeDefined();
	});

	it('throws WrongPasswordError when the current password is wrong (nothing staged)', async () => {
		const { record } = await sealed('old-pw');
		await expect(stageRewrap(record, 'not-the-pw', 'new-pw')).rejects.toBeInstanceOf(WrongPasswordError);
	});

	// Opening a two-wrap record via the OLD password (the change never reached the
	// server, or was rolled back) must return a cleaned record the caller persists
	// — one that opens with the old password ONLY.
	it('opening via the old password collapses to an old-only record', async () => {
		const { record } = await sealed('old-pw');
		const staged = await stageRewrap(record, 'old-pw', 'new-pw');
		const opened = await openIdentityRecord<typeof DOC>(staged, 'old-pw');
		expect(opened.migrated).toBeDefined();
		expect(opened.migrated!.altWrap).toBeUndefined();
		await expect(openIdentityRecord(opened.migrated!, 'new-pw')).rejects.toBeInstanceOf(WrongPasswordError);
		expect((await openIdentityRecord<typeof DOC>(opened.migrated!, 'old-pw')).doc).toEqual(DOC);
	});

	// Opening via the NEW password (the server accepted the change) must collapse
	// to a new-only record — the old password is now dead locally too.
	it('opening via the new password collapses to a new-only record', async () => {
		const { record } = await sealed('old-pw');
		const staged = await stageRewrap(record, 'old-pw', 'new-pw');
		const opened = await openIdentityRecord<typeof DOC>(staged, 'new-pw');
		expect(opened.migrated).toBeDefined();
		expect(opened.migrated!.altWrap).toBeUndefined();
		await expect(openIdentityRecord(opened.migrated!, 'old-pw')).rejects.toBeInstanceOf(WrongPasswordError);
		expect((await openIdentityRecord<typeof DOC>(opened.migrated!, 'new-pw')).doc).toEqual(DOC);
	});

	it('a bad password fails even mid-change (neither wrap opens)', async () => {
		const { record } = await sealed('old-pw');
		const staged = await stageRewrap(record, 'old-pw', 'new-pw');
		await expect(openIdentityRecord(staged, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError);
	});

	it('tampering the alt wrap makes the new password fail (old still works)', async () => {
		const { record } = await sealed('old-pw');
		const staged = await stageRewrap(record, 'old-pw', 'new-pw');
		const ct = staged.altWrap!.ciphertext;
		const tampered: IdentityRecordV2 = {
			...staged,
			altWrap: { ...staged.altWrap!, ciphertext: (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1) },
		};
		await expect(openIdentityRecord(tampered, 'new-pw')).rejects.toBeInstanceOf(WrongPasswordError);
		expect((await openIdentityRecord<typeof DOC>(tampered, 'old-pw')).doc).toEqual(DOC);
	});

	it('stages on a legacy v1 record too (migrate + add the new wrap)', async () => {
		const { record } = await makeV1('old-pw');
		const staged = await stageRewrap(record, 'old-pw', 'new-pw');
		expect(staged.version).toBe(2);
		expect((await openIdentityRecord<typeof DOC>(staged, 'old-pw')).doc).toEqual(DOC);
		expect((await openIdentityRecord<typeof DOC>(staged, 'new-pw')).doc).toEqual(DOC);
	});
});

describe('promoteRewrap / abortRewrap — settling a staged change', () => {
	it('promoteRewrap keeps the NEW password and drops the old', async () => {
		const mk = generateMasterKey();
		const record = await sealIdentityRecord(DOC, 'old-pw', mk);
		const staged = await stageRewrap(record, 'old-pw', 'new-pw');
		const promoted = promoteRewrap(staged);
		expect(promoted.altWrap).toBeUndefined();
		expect(bytesEqual((await openIdentityRecord<typeof DOC>(promoted, 'new-pw')).masterKey, mk)).toBe(true);
		await expect(openIdentityRecord(promoted, 'old-pw')).rejects.toBeInstanceOf(WrongPasswordError);
	});

	it('abortRewrap keeps the OLD password and drops the new', async () => {
		const mk = generateMasterKey();
		const record = await sealIdentityRecord(DOC, 'old-pw', mk);
		const staged = await stageRewrap(record, 'old-pw', 'new-pw');
		const aborted = abortRewrap(staged);
		expect(aborted.altWrap).toBeUndefined();
		expect(bytesEqual((await openIdentityRecord<typeof DOC>(aborted, 'old-pw')).masterKey, mk)).toBe(true);
		await expect(openIdentityRecord(aborted, 'new-pw')).rejects.toBeInstanceOf(WrongPasswordError);
	});
});
