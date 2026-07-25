// WebAuthn-PRF unlock, keystore half. The WebAuthn call itself lives in
// src/lib/webauthnPrf.ts and needs a real authenticator, so what is testable
// here is the part that matters cryptographically: MK is wrapped under a
// PRF-derived key, the wrap at rest is useless without that exact key, and a
// wrap that no longer opens is discarded rather than left as an unlock option
// that can never work.
import { describe, expect, it } from 'vitest';
import * as keystore from '../src/keystore';

function fakeWrappingKey(seed: number): Uint8Array {
	return new Uint8Array(32).fill(seed);
}

const enrollment = (seed: number) => ({
	credentialId: `cred-${seed}`,
	prfSalt: `salt-${seed}`,
	wrappingKey: fakeWrappingKey(seed),
});

describe('passkey (WebAuthn-PRF) unlock', () => {
	it('round-trips: enroll, lock, then unlock with the same PRF key', async () => {
		const u = 'pk_rt';
		const created = await keystore.createIdentity(u, 'pw');
		await keystore.enrollPasskeyUnlock(u, enrollment(1));
		expect(await keystore.isPasskeyUnlockEnrolled(u)).toBe(true);

		// Drop the cached MK, as a page reload does.
		keystore.lock(u);

		const result = await keystore.unlockWithPasskey(u, fakeWrappingKey(1));
		expect(result.status).toBe('unlocked');
		if (result.status !== 'unlocked') throw new Error('unreachable');
		// Same identity as the one created — not a fresh keypair.
		expect(Array.from(result.identity.signing.publicKey)).toEqual(Array.from(created.identity.signing.publicKey));

		// And the keystore is genuinely usable afterwards (MK really was cached).
		await expect(keystore.addOneTimePreKeys(u, 1)).resolves.toHaveLength(1);
	});

	it('a WRONG PRF key cannot open the wrap', async () => {
		const u = 'pk_wrong';
		await keystore.createIdentity(u, 'pw');
		await keystore.enrollPasskeyUnlock(u, enrollment(2));
		keystore.lock(u);

		const result = await keystore.unlockWithPasskey(u, fakeWrappingKey(99));
		expect(result.status).toBe('cancelled');
	});

	it('drops a stale enrollment that no longer opens, so it stops being offered', async () => {
		const u = 'pk_stale';
		await keystore.createIdentity(u, 'pw');
		await keystore.enrollPasskeyUnlock(u, enrollment(3));
		keystore.lock(u);

		await keystore.unlockWithPasskey(u, fakeWrappingKey(77)); // fails to unwrap
		expect(await keystore.isPasskeyUnlockEnrolled(u)).toBe(false);
	});

	it('exposes only the assertion params, never the wrapped key', async () => {
		const u = 'pk_params';
		await keystore.createIdentity(u, 'pw');
		await keystore.enrollPasskeyUnlock(u, enrollment(4));

		const params = await keystore.getPasskeyUnlockParams(u);
		expect(params).toEqual({ credentialId: 'cred-4', prfSalt: 'salt-4' });
		expect(JSON.stringify(params)).not.toContain('wrap');
	});

	it('disabling removes the enrollment', async () => {
		const u = 'pk_disable';
		await keystore.createIdentity(u, 'pw');
		await keystore.enrollPasskeyUnlock(u, enrollment(5));
		await keystore.disablePasskeyUnlock(u);
		expect(await keystore.isPasskeyUnlockEnrolled(u)).toBe(false);
		expect(await keystore.getPasskeyUnlockParams(u)).toBeNull();
	});

	it('reports no-local-identity when there is nothing to unlock', async () => {
		const result = await keystore.unlockWithPasskey('pk_nobody', fakeWrappingKey(1));
		expect(result.status).toBe('no-local-identity');
	});

	it('enrolling requires an unlocked keystore (MK must be cached)', async () => {
		const u = 'pk_locked';
		await keystore.createIdentity(u, 'pw');
		keystore.lock(u);
		await expect(keystore.enrollPasskeyUnlock(u, enrollment(6))).rejects.toThrow();
	});
});
