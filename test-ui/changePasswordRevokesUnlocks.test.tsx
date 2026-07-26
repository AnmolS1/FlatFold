// FULL_AUDIT_2 S1. Changing your password must cut off the device unlocks.
//
// The envelope design is right and is not what's being changed here: a password
// change re-wraps the SAME master key, which is what makes it atomic and lets a
// crash mid-change recover. But the consequence is that MK never rotates, so
// every unlock path that holds a copy of MK — the passkey wrap in PASSKEY_STORE,
// the Secure-Enclave Keychain item on iOS — keeps working afterwards.
//
// That breaks the promise the action makes. People change their password because
// they believe it is compromised, and specifically because they believe it cuts
// off whoever has it. If someone had this device long enough to enroll Touch ID,
// the change they just made did not touch them. The server side already gets this
// right: the epoch bump kills every other session.
//
// So: revoke the local enrollments on a successful change, and make the user
// re-enroll deliberately. No MK rotation needed.
//
// This runs the REAL keystore against fake-indexeddb — the assertion is that the
// passkey record is actually gone from storage, not that some spy was called.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as keystore from '../src/keystore';
import { useAuth } from '../src/hooks/useAuth';

const apiChangePassword = vi.fn<(current: string, next: string) => Promise<void>>();

// Only the server calls are stubbed. `apiMe` decides who the provider thinks is
// signed in, which is how the test gets a `username` without a real session.
vi.mock('../src/lib/api', () => ({
	apiMe: () => Promise.resolve({ username: 'wren' }),
	apiChangePassword: (current: string, next: string) => apiChangePassword(current, next),
	apiLogin: vi.fn(),
	apiLogout: vi.fn(),
	apiSignup: vi.fn(),
	apiPublishKeys: vi.fn(),
	apiEnrollRecovery: vi.fn(),
	apiRecoveryParams: vi.fn(),
	apiRecoveryReset: vi.fn(),
}));

import { AuthProvider } from '../src/contexts/AuthContext';

const USER = 'wren';

/** Minimal consumer: one button that runs the change, one line that reports it. */
const ChangePasswordProbe = () => {
	const { username, changePassword } = useAuth();
	return (
		<>
			<span>user:{username ?? 'none'}</span>
			<button
				onClick={() =>
					void changePassword('old-pw', 'new-pw').then(
						(r) => (document.title = r),
						// Caught, not swallowed: the rejection path is a case under test,
						// and an unhandled one would leave the suite's output dirty.
						(e: Error) => (document.title = `threw:${e.message}`)
					)
				}
			>
				change
			</button>
		</>
	);
};

async function renderAndChangePassword(): Promise<void> {
	render(
		<AuthProvider>
			<ChangePasswordProbe />
		</AuthProvider>
	);
	// Wait for apiMe to settle, or `changePassword` throws on a null username.
	await screen.findByText(`user:${USER}`);
	await userEvent.click(screen.getByRole('button', { name: 'change' }));
	await vi.waitFor(() => expect(document.title).toBe('ok'));
}

describe('changing the password revokes device unlock enrollments (S1)', () => {
	beforeEach(async () => {
		document.title = '';
		apiChangePassword.mockReset().mockResolvedValue(undefined);
		await keystore.wipeAll(USER);
		await keystore.disablePasskeyUnlock(USER);
		await keystore.createIdentity(USER, 'old-pw');
	});

	it('drops the passkey unlock enrollment', async () => {
		await keystore.enrollPasskeyUnlock(USER, {
			credentialId: 'cred-s1',
			prfSalt: 'salt-s1',
			wrappingKey: new Uint8Array(32).fill(7),
		});
		expect(await keystore.isPasskeyUnlockEnrolled(USER)).toBe(true);

		await renderAndChangePassword();

		expect(await keystore.isPasskeyUnlockEnrolled(USER)).toBe(false);
		// And the stale wrap is genuinely unusable, not merely un-advertised: a
		// record left behind would still open MK for anyone holding that
		// authenticator, which is the whole point of the finding.
		expect(await keystore.getPasskeyUnlockParams(USER)).toBeNull();
	});

	it('still reports ok, and the new password unlocks', async () => {
		await renderAndChangePassword();

		expect(apiChangePassword).toHaveBeenCalledWith('old-pw', 'new-pw');
		keystore.lock(USER);
		expect((await keystore.unlock(USER, 'new-pw')).status).toBe('unlocked');
	});

	it('does not revoke anything when the server rejects the change', async () => {
		await keystore.enrollPasskeyUnlock(USER, {
			credentialId: 'cred-s1b',
			prfSalt: 'salt-s1b',
			wrappingKey: new Uint8Array(32).fill(9),
		});
		apiChangePassword.mockRejectedValue(new Error('server said no'));

		render(
			<AuthProvider>
				<ChangePasswordProbe />
			</AuthProvider>
		);
		await screen.findByText(`user:${USER}`);
		await userEvent.click(screen.getByRole('button', { name: 'change' }));

		await vi.waitFor(() => expect(document.title).toBe('threw:server said no'));

		// The password did not change, so the enrollment must survive — revoking
		// here would lock someone out of their own unlock for nothing.
		expect(await keystore.isPasskeyUnlockEnrolled(USER)).toBe(true);
		keystore.lock(USER);
		expect((await keystore.unlock(USER, 'old-pw')).status).toBe('unlocked');
	});
});
