import { useState, useEffect, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Fingerprint } from 'lucide-react';
import { LogoMark } from './common/Brand';
import { useAuth } from '../hooks/useAuth';
import { requestPanicWipe } from '../lib/panicWipe';
import { isBiometricEnrolled } from '../keystore';

interface KeystoreUnlockGateProps {
	children: ReactNode;
}

// Shown when a valid server session exists but this tab has no cached
// keystore key — a fresh tab, or the server's cookie outliving the
// sessionStorage-scoped key. See AuthContext.tsx for why unlocking the
// local keystore is a step separate from the server session.
export const KeystoreUnlockGate = ({ children }: KeystoreUnlockGateProps) => {
	const { username, keystoreLocked, unlockKeystore, unlockWithBiometric, logout } = useAuth();
	const [password, setPassword] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [unlocking, setUnlocking] = useState(false);
	const [bioEnrolled, setBioEnrolled] = useState(false);
	const navigate = useNavigate();

	// Escape hatches. Without these the gate is a trap: the server session is still
	// valid, so `username` is set and /login bounces straight back here — leaving a
	// forgotten password with no way out except the (destructive) panic wipe.
	// Navigate FIRST so /login is mounted with the right intent, then drop the
	// session; Login skips its usual redirect while the keystore is locked.
	const leaveGate = (to: string) => {
		navigate(to, { replace: true });
		void logout();
	};

	// If biometric unlock is enrolled, offer it — and auto-try once so the Face ID
	// sheet comes up straight away (password stays as the fallback).
	useEffect(() => {
		if (!keystoreLocked || !username) return;
		let cancelled = false;
		void (async () => {
			if (!(await isBiometricEnrolled(username)) || cancelled) return;
			setBioEnrolled(true);
			await unlockWithBiometric(); // resolves 'cancelled' silently → stay on password
		})();
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [keystoreLocked, username]);

	if (!keystoreLocked) return <>{children}</>;

	const tryBiometric = async () => {
		setError(null);
		await unlockWithBiometric();
	};

	const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError(null);
		setUnlocking(true);
		try {
			const result = await unlockKeystore(password);
			if (result === 'wrong-password') setError('Wrong password.');
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to unlock.');
		} finally {
			setUnlocking(false);
		}
	};

	return (
		<div className="min-h-screen flex items-center justify-center p-4 bg-graph">
			<div className="max-w-sm w-full text-center">
				<div className="flex justify-center mb-4">
					<LogoMark size={40} />
				</div>
				<h1 className="font-display text-xl font-bold text-graphite mb-2">Unlock this device</h1>
				<p className="text-graphite-60 text-sm mb-6">
					{username}&rsquo;s encrypted data on this device needs your password again — a separate, local-only
					step from signing in.
				</p>
				{bioEnrolled && (
					<button
						onClick={() => void tryBiometric()}
						className="w-full mb-3 flex items-center justify-center gap-2 border border-crease-line-bold text-graphite rounded-lg px-4 py-2 hover:border-crease transition-colors"
					>
						<Fingerprint className="w-5 h-5" /> Unlock with Face ID
					</button>
				)}
				<form onSubmit={handleSubmit} className="space-y-3">
					{/* Hidden username + current-password autocomplete so a password
					    manager (1Password, iCloud Keychain) recognises this as a sign-in
					    for THIS account and offers to fill it. The key is memory-only by
					    design, so this screen recurs on every reload — autofill is what
					    makes that livable without weakening the tradeoff. */}
					<input type="text" name="username" value={username ?? ''} readOnly hidden autoComplete="username" />
					<input
						type="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						placeholder="Password"
						autoFocus
						autoComplete="current-password"
						className="w-full rounded-lg border border-crease-line-bold bg-inset text-graphite placeholder-graphite-40 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-crease focus:border-transparent"
					/>
					{error && <p className="text-sm text-crane">{error}</p>}
					<button
						type="submit"
						disabled={unlocking || !password}
						className="w-full bg-crane text-white px-4 py-2 rounded-lg hover:bg-crane-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
					>
						{unlocking ? 'Unlocking…' : 'Unlock'}
					</button>
				</form>
				<div className="mt-5 flex flex-col gap-2 text-sm">
					<button
						onClick={() => leaveGate('/login?recover=1')}
						className="text-crease hover:text-crane transition-colors"
					>
						Forgot your password?
					</button>
					<button
						onClick={() => leaveGate('/login')}
						className="text-graphite-60 hover:text-graphite transition-colors"
					>
						Not {username}? Sign in to another account
					</button>
				</div>
				<button
					onClick={() => requestPanicWipe()}
					className="mt-6 text-xs text-graphite-40 hover:text-crane transition-colors underline"
				>
					Panic wipe this device
				</button>
			</div>
		</div>
	);
};
