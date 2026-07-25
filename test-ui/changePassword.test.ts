// Keystore-level change-password wiring (D7 §1), exercised through the real
// (fake-indexeddb) storage layer. The pure two-wrap crypto is covered in
// identityRecord.test.ts; this proves the index.ts orchestration end to end:
// stage makes the record durable and openable by either password; finalize keeps
// the new one; rollback keeps the old; and a mid-change crash (stage without
// settle) still unlocks with whichever password the server ended up on, then
// collapses to a single wrap.
import { describe, expect, it } from 'vitest';
import * as keystore from '../src/keystore';

// Each test uses a distinct username so the shared in-memory IndexedDB can't leak
// state between cases.
async function freshIdentity(username: string, password: string): Promise<void> {
	await keystore.createIdentity(username, password);
	keystore.lock(username); // drop the cached MK so unlock() is exercised for real
}

describe('keystore change-password wiring', () => {
	it('stage → finalize: the new password unlocks, the old is dead', async () => {
		const u = 'cp_finalize';
		await freshIdentity(u, 'old-pw');

		expect(await keystore.stageChangePassword(u, 'old-pw', 'new-pw')).toBe('ok');
		await keystore.finalizeChangePassword(u);

		expect((await keystore.unlock(u, 'new-pw')).status).toBe('unlocked');
		keystore.lock(u);
		expect((await keystore.unlock(u, 'old-pw')).status).toBe('wrong-password');
	});

	// The "both passwords open a staged record" property is proven purely (no
	// persistence) in identityRecord.test.ts. At the keystore layer, unlock()
	// PERSISTS the collapse — so the first password used wins and the stale wrap is
	// dropped, which is exactly the crash-recovery cleanup we want.
	it('mid-change, unlocking with the OLD password collapses to old-only', async () => {
		const u = 'cp_stale_old';
		await freshIdentity(u, 'old-pw');
		expect(await keystore.stageChangePassword(u, 'old-pw', 'new-pw')).toBe('ok');

		expect((await keystore.unlock(u, 'old-pw')).status).toBe('unlocked');
		keystore.lock(u);
		expect((await keystore.unlock(u, 'new-pw')).status).toBe('wrong-password');
	});

	it('stage → rollback: the old password still unlocks, the new never took', async () => {
		const u = 'cp_rollback';
		await freshIdentity(u, 'old-pw');

		expect(await keystore.stageChangePassword(u, 'old-pw', 'new-pw')).toBe('ok');
		await keystore.rollbackChangePassword(u);

		expect((await keystore.unlock(u, 'old-pw')).status).toBe('unlocked');
		keystore.lock(u);
		expect((await keystore.unlock(u, 'new-pw')).status).toBe('wrong-password');
	});

	it('wrong current password stages nothing', async () => {
		const u = 'cp_wrongcurrent';
		await freshIdentity(u, 'old-pw');

		expect(await keystore.stageChangePassword(u, 'not-it', 'new-pw')).toBe('wrong-password');

		// Untouched: old still works, the never-offered new does not.
		expect((await keystore.unlock(u, 'old-pw')).status).toBe('unlocked');
		keystore.lock(u);
		expect((await keystore.unlock(u, 'new-pw')).status).toBe('wrong-password');
	});

	it('crash after server-accept (stage, no settle) → new password unlocks and collapses', async () => {
		const u = 'cp_crash';
		await freshIdentity(u, 'old-pw');

		expect(await keystore.stageChangePassword(u, 'old-pw', 'new-pw')).toBe('ok');

		// Simulate: server accepted the new password, app died before finalize. The
		// user re-logs in with the NEW password; unlock opens via the alt wrap AND
		// persists the collapsed (new-only) record.
		expect((await keystore.unlock(u, 'new-pw')).status).toBe('unlocked');
		keystore.lock(u);

		// The collapse means the old password is now dead even without an explicit
		// finalize — the stale wrap was dropped on that unlock.
		expect((await keystore.unlock(u, 'old-pw')).status).toBe('wrong-password');
		keystore.lock(u);
		expect((await keystore.unlock(u, 'new-pw')).status).toBe('unlocked');
	});

	it('preserves the identity keys across a change', async () => {
		const u = 'cp_intact';
		const material = await keystore.createIdentity(u, 'old-pw');
		keystore.lock(u);

		await keystore.stageChangePassword(u, 'old-pw', 'new-pw');
		await keystore.finalizeChangePassword(u);

		const opened = await keystore.unlock(u, 'new-pw');
		expect(opened.status).toBe('unlocked');
		if (opened.status !== 'unlocked') return;
		expect(opened.identity.signing.publicKey).toEqual(material.identity.signing.publicKey);
		expect(opened.identity.dh.publicKey).toEqual(material.identity.dh.publicKey);
	});
});
