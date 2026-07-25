// One-time-prekey replenishment, client half (FULL_AUDIT §2 follow-up).
//
// THE invariant this file exists to protect: a public key must never reach the
// server unless its secret is already durably stored locally. Publishing a
// prekey we can't decrypt with would wedge first contact for whoever claims it
// (they'd build an X3DH session against a key we can't complete), and the
// server deletes each prekey on use, so the damage would be silent and
// unrecoverable for that conversation. Hence: persist locally FIRST, publish
// second — the same ordering discipline as D7's stageRewrap.
import { describe, expect, it } from 'vitest';
import * as keystore from '../src/keystore';
import { bytesToBase64 } from '../src/keystore/codec';

describe('keystore.addOneTimePreKeys', () => {
	it('returns fresh public keys whose secrets are ALREADY retrievable locally', async () => {
		const u = 'pk_persist';
		await keystore.createIdentity(u, 'pw');

		const added = await keystore.addOneTimePreKeys(u, 5);
		expect(added).toHaveLength(5);

		// Every published key must resolve to a stored secret. This is the
		// publish-safety invariant: if this fails, we'd be handing out keys we
		// cannot complete a handshake with.
		for (const publicKey of added) {
			const secret = await keystore.takeOneTimePreKeySecret(u, publicKey);
			expect(secret).toBeTruthy();
			expect(secret!.length).toBeGreaterThan(0);
		}
	});

	it('adds to the existing pool rather than replacing it', async () => {
		const u = 'pk_append';
		// createIdentity seeds 20; those secrets must survive a top-up.
		const material = await keystore.createIdentity(u, 'pw');
		const original = material.oneTimePreKeys.map((opk) => bytesToBase64(opk.keyPair.publicKey));
		expect(original.length).toBe(20);

		const added = await keystore.addOneTimePreKeys(u, 3);

		// New keys are genuinely new...
		for (const k of added) expect(original).not.toContain(k);
		// ...and an ORIGINAL key still resolves, i.e. nothing was clobbered.
		const stillThere = await keystore.takeOneTimePreKeySecret(u, original[0]);
		expect(stillThere).toBeTruthy();
	});

	it('generates distinct keys across calls (no reuse)', async () => {
		const u = 'pk_distinct';
		await keystore.createIdentity(u, 'pw');
		const first = await keystore.addOneTimePreKeys(u, 4);
		const second = await keystore.addOneTimePreKeys(u, 4);
		const overlap = first.filter((k) => second.includes(k));
		expect(overlap).toEqual([]);
		expect(new Set([...first, ...second]).size).toBe(8);
	});

	it('survives a reload: secrets are persisted, not just in memory', async () => {
		const u = 'pk_durable';
		await keystore.createIdentity(u, 'pw');
		const added = await keystore.addOneTimePreKeys(u, 2);

		// Drop the in-memory key cache and re-unlock, as a page reload would.
		keystore.lock(u);
		await keystore.unlock(u, 'pw');

		for (const publicKey of added) {
			expect(await keystore.takeOneTimePreKeySecret(u, publicKey)).toBeTruthy();
		}
	});

	it('is a no-op for a non-positive count', async () => {
		const u = 'pk_zero';
		await keystore.createIdentity(u, 'pw');
		expect(await keystore.addOneTimePreKeys(u, 0)).toEqual([]);
		expect(await keystore.addOneTimePreKeys(u, -3)).toEqual([]);
	});
});
