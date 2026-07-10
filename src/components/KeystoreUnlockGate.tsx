import { useState, type FormEvent, type ReactNode } from 'react';
import { LogoMark } from './common/Brand';
import { useAuth } from '../hooks/useAuth';
import { requestPanicWipe } from '../lib/panicWipe';

interface KeystoreUnlockGateProps {
	children: ReactNode;
}

// Shown when a valid server session exists but this tab has no cached
// keystore key — a fresh tab, or the server's cookie outliving the
// sessionStorage-scoped key. See AuthContext.tsx for why unlocking the
// local keystore is a step separate from the server session.
export const KeystoreUnlockGate = ({ children }: KeystoreUnlockGateProps) => {
	const { username, keystoreLocked, unlockKeystore } = useAuth();
	const [password, setPassword] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [unlocking, setUnlocking] = useState(false);

	if (!keystoreLocked) return <>{children}</>;

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
				<form onSubmit={handleSubmit} className="space-y-3">
					<input
						type="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						placeholder="Password"
						autoFocus
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
