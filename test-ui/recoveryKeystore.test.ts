// D7 Phase 2b — keystore recovery wiring, through the real (fake-indexeddb)
// storage layer. enrollRecovery snapshots the identity keypair + contacts under
// the recovery code; restoreFromRecovery rebuilds a working local identity on a
// "new device" from just the code + the server-held blob — SAME identity keys
// (no safety-number change), contacts back, fresh ephemeral prekeys.
import { describe, expect, it } from 'vitest';
import * as keystore from '../src/keystore';
import { generateIdentityKeyPair } from '../src/crypto';
import { bytesToBase64 } from '../src/keystore/codec';
import { openRecoveryBlob, generateRecoveryCode, InvalidRecoveryCodeError } from '../src/keystore/recovery';

function bobPublicKeys() {
	const kp = generateIdentityKeyPair();
	return { signingPublicKey: kp.signing.publicKey, dhPublicKey: kp.dh.publicKey };
}

describe('keystore recovery enroll + restore', () => {
	it('enrolls: the blob opens to the identity keypair + contacts snapshot', async () => {
		const u = 'rec_enroll';
		await keystore.createIdentity(u, 'pw');
		const bob = bobPublicKeys();
		await keystore.addContact(u, 'bob', bob);

		const { code, enrollment } = await keystore.enrollRecovery(u);
		expect(code.split(' ').length).toBe(12);

		// The opaque blob decrypts (with the code) to a payload carrying the
		// identity secret keys and the contact — proving what's backed up.
		const bytes = await openRecoveryBlob(code, enrollment.saltRec, enrollment.blob);
		const payload = JSON.parse(new TextDecoder().decode(bytes));
		expect(payload.identity.signingSecretKey).toBeTruthy();
		expect(payload.contacts.bob).toBeTruthy();
		expect(payload.contacts.bob.signingPublicKey).toBe(bytesToBase64(bob.signingPublicKey));
	});

	it('restores on a fresh device: same identity keys, contacts back, new password unlocks', async () => {
		const u = 'rec_restore';
		const original = await keystore.createIdentity(u, 'old-pw');
		const bob = bobPublicKeys();
		await keystore.addContact(u, 'bob', bob);
		await keystore.setVerified(u, 'bob', true);
		const { code, enrollment } = await keystore.enrollRecovery(u);

		// Simulate a new device / reinstall: no local data at all.
		await keystore.wipeAll(u);
		expect(await keystore.hasLocalIdentity(u)).toBe(false);

		const material = await keystore.restoreFromRecovery(u, code, enrollment.saltRec, enrollment.blob, 'new-pw');
		// Same identity public keys as before → contacts see NO safety-number change.
		expect(material.identity.signing.publicKey).toEqual(original.identity.signing.publicKey);
		expect(material.identity.dh.publicKey).toEqual(original.identity.dh.publicKey);
		// Fresh ephemeral material (regenerated, not the old snapshot).
		expect(material.oneTimePreKeys.length).toBeGreaterThan(0);

		// The new password unlocks the restored keystore.
		const opened = await keystore.unlock(u, 'new-pw');
		expect(opened.status).toBe('unlocked');
		if (opened.status !== 'unlocked') return;
		expect(opened.identity.signing.publicKey).toEqual(original.identity.signing.publicKey);

		// The verified contact came back.
		const contacts = await keystore.listContacts(u);
		const restoredBob = contacts.find((c) => c.username === 'bob');
		expect(restoredBob).toBeTruthy();
		expect(restoredBob!.verified).toBe(true);
	});

	it('restore with a wrong code throws InvalidRecoveryCodeError and writes nothing', async () => {
		const u = 'rec_wrongcode';
		await keystore.createIdentity(u, 'old-pw');
		const { enrollment } = await keystore.enrollRecovery(u);
		await keystore.wipeAll(u);

		const wrong = generateRecoveryCode();
		await expect(
			keystore.restoreFromRecovery(u, wrong, enrollment.saltRec, enrollment.blob, 'new-pw')
		).rejects.toBeInstanceOf(InvalidRecoveryCodeError);
		expect(await keystore.hasLocalIdentity(u)).toBe(false);
	});
});
