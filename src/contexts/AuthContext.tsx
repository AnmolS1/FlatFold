import { useEffect, useState, type ReactNode } from 'react';
import {
	apiChangePassword,
	apiEnrollRecovery,
	apiLogin,
	apiLogout,
	apiMe,
	apiPublishKeys,
	apiRecoveryParams,
	apiRecoveryReset,
	apiSignup,
} from '../lib/api';
import * as keystore from '../keystore';
import { deriveRecoveryAuth } from '../keystore/recovery';
import { bytesToBase64 } from '../keystore/codec';
import type { EncryptedBlob } from '../keystore/crypto';
import type { NewIdentityMaterial } from '../keystore';
import type { AuthContextType } from '../types';
import { AuthContext } from '../hooks/useAuth';

interface AuthProviderProps {
	children: ReactNode;
}

async function publishIdentityMaterial(material: NewIdentityMaterial): Promise<void> {
	await apiPublishKeys({
		identityPubkey: {
			signingPublicKey: bytesToBase64(material.identity.signing.publicKey),
			dhPublicKey: bytesToBase64(material.identity.dh.publicKey),
		},
		signedPrekey: {
			publicKey: bytesToBase64(material.signedPreKey.keyPair.publicKey),
			signature: bytesToBase64(material.signedPreKey.signature),
		},
		oneTimePreKeys: material.oneTimePreKeys.map((opk) => bytesToBase64(opk.keyPair.publicKey)),
	});
}

async function publishFreshIdentity(username: string, password: string): Promise<void> {
	await publishIdentityMaterial(await keystore.createIdentity(username, password));
}

// Unlocks this user's local encrypted keystore — or, on a device with no
// local identity yet, generates a fresh one and publishes it. This is a
// SEPARATE step from the server login above: the server session is a
// cookie restored on every fresh load via GET /api/auth/me, but the
// keystore key is derived from the password, which is never retained in
// memory past this call. A plain reload can't re-derive it from nothing —
// see `keystoreLocked` below for how the app surfaces that.
//
// Throws only on a genuine wrong-password mismatch against local storage,
// which shouldn't happen right after the server already accepted this same
// password — short of local data corruption.
async function establishLocalIdentity(username: string, password: string): Promise<void> {
	const result = await keystore.unlock(username, password);
	if (result.status === 'wrong-password') {
		throw new Error('Could not unlock your local encrypted data with that password.');
	}
	if (result.status === 'no-local-identity') {
		// New device, or local storage was cleared: no key escrow / no
		// cross-device backup in v1, so the honest move is a fresh identity,
		// re-published — existing contacts will see this user's safety number
		// change next time they message (the non-dismissable warning for that
		// is a later milestone's UI).
		await publishFreshIdentity(username, password);
	}
}

export const AuthProvider = ({ children }: AuthProviderProps) => {
	const [username, setUsername] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	// True once `username` is known but this tab has no cached keystore key
	// — the derived key lives in sessionStorage (per-tab, cleared on tab
	// close), not localStorage, so a fresh tab with an otherwise-valid
	// session cookie still needs an explicit re-unlock.
	const [keystoreLocked, setKeystoreLocked] = useState(false);

	// Bootstrap session state from the httpOnly cookie on load — this
	// replaces Firebase's onAuthStateChanged.
	useEffect(() => {
		let cancelled = false;

		apiMe()
			.then((result) => {
				if (cancelled) return;
				const restoredUsername = result?.username ?? null;
				setUsername(restoredUsername);
				if (restoredUsername) setKeystoreLocked(!keystore.isUnlocked(restoredUsername));
			})
			.catch(() => {
				if (!cancelled) setUsername(null);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, []);

	const signup = async (usernameInput: string, password: string): Promise<void> => {
		const result = await apiSignup(usernameInput, password);
		await establishLocalIdentity(result.username, password);
		setUsername(result.username);
		setKeystoreLocked(false);
	};

	const login = async (usernameInput: string, password: string): Promise<void> => {
		const result = await apiLogin(usernameInput, password);
		await establishLocalIdentity(result.username, password);
		setUsername(result.username);
		setKeystoreLocked(false);
	};

	const logout = async (): Promise<void> => {
		// Purge the in-memory keystore key on sign-out — otherwise it would
		// linger in the JS heap across a client-side navigation until the next
		// reload (M7 fix).
		if (username) keystore.lock(username);
		await apiLogout();
		setUsername(null);
		setKeystoreLocked(true);
	};

	const unlockKeystore = async (password: string): Promise<'unlocked' | 'wrong-password'> => {
		if (!username) throw new Error('Cannot unlock keystore with no authenticated user.');
		const result = await keystore.unlock(username, password);
		if (result.status === 'wrong-password') return 'wrong-password';
		if (result.status === 'no-local-identity') {
			await publishFreshIdentity(username, password);
		}
		setKeystoreLocked(false);
		return 'unlocked';
	};

	// Change password (D7 §1). Ordering is what makes it crash-safe across two
	// independent stores (local keystore + server verifier):
	//   1. stage — durably add a SECOND wrap of the master key under the new
	//      password to the local record. It now opens with EITHER password.
	//   2. server — re-auth with the current password; the server rotates the
	//      verifier + epoch and returns a fresh token for this session.
	//   3. finalize — promote the new wrap to be the only one; the old dies.
	// A crash between (1) and (3) is safe: the record still opens with whichever
	// password the server ended up on, and the next unlock collapses it. On a
	// server rejection we roll the staged wrap back so the old password is intact.
	const changePassword = async (current: string, next: string): Promise<'ok' | 'wrong-password'> => {
		if (!username) throw new Error('Cannot change password with no authenticated user.');
		const staged = await keystore.stageChangePassword(username, current, next);
		if (staged === 'wrong-password') return 'wrong-password';
		try {
			await apiChangePassword(current, next);
		} catch (err) {
			await keystore.rollbackChangePassword(username);
			throw err;
		}
		await keystore.finalizeChangePassword(username);
		return 'ok';
	};

	// Turn on (or replace) a recovery code (D7 §3). The keystore builds the code +
	// opaque blob from the unlocked identity; the server stores it after a password
	// re-auth. The code is returned to show ONCE and is never retained.
	const enrollRecovery = async (password: string): Promise<string> => {
		if (!username) throw new Error('Cannot set up recovery with no authenticated user.');
		const { code, enrollment } = await keystore.enrollRecovery(username);
		await apiEnrollRecovery(password, {
			saltRec: enrollment.saltRec,
			saltAuth: enrollment.saltAuth,
			blob: enrollment.blob,
			auth: enrollment.auth,
		});
		return code;
	};

	// Recover an account on this device from its recovery code (D7 §3). Fetches the
	// public salts, derives the authenticator, resets the password server-side (which
	// releases the opaque blob), then rebuilds the identity + contacts locally under
	// the new password and republishes. The identity keys are unchanged, so contacts
	// see no safety-number change.
	const recoverAccount = async (
		usernameInput: string,
		code: string,
		newPassword: string
	): Promise<'ok' | 'no-recovery' | 'wrong-code'> => {
		const params = await apiRecoveryParams(usernameInput);
		if (!params) return 'no-recovery';

		let recAuth: string;
		try {
			recAuth = await deriveRecoveryAuth(code, params.saltAuth);
		} catch {
			return 'wrong-code'; // invalid mnemonic / bad checksum
		}

		const result = await apiRecoveryReset(usernameInput, recAuth, newPassword);
		if (result === 'wrong-code') return 'wrong-code';

		const material = await keystore.restoreFromRecovery(
			usernameInput,
			code,
			params.saltRec,
			result.blob as EncryptedBlob,
			newPassword
		);
		await publishIdentityMaterial(material);
		setUsername(usernameInput);
		setKeystoreLocked(false);
		return 'ok';
	};

	const value: AuthContextType = {
		username,
		loading,
		keystoreLocked,
		signup,
		login,
		logout,
		unlockKeystore,
		changePassword,
		enrollRecovery,
		recoverAccount,
	};

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
