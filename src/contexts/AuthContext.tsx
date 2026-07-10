import { useEffect, useState, type ReactNode } from 'react';
import { apiLogin, apiLogout, apiMe, apiPublishKeys, apiSignup } from '../lib/api';
import * as keystore from '../keystore';
import { bytesToBase64 } from '../keystore/codec';
import type { AuthContextType } from '../types';
import { AuthContext } from '../hooks/useAuth';

interface AuthProviderProps {
	children: ReactNode;
}

async function publishFreshIdentity(username: string, password: string): Promise<void> {
	const material = await keystore.createIdentity(username, password);
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

	const value: AuthContextType = {
		username,
		loading,
		keystoreLocked,
		signup,
		login,
		logout,
		unlockKeystore,
	};

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
