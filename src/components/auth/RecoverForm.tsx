import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { User, KeyRound, Lock, ArrowLeft } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useToast } from '../../hooks/useToast';

// D7 §3 forgot-password flow. The user proves ownership with the recovery code
// they saved when they turned it on, and sets a new password. On success their
// identity + contacts are restored (same keys → no safety-number change); past
// messages that only ever lived on the old device do not come back.
export const RecoverForm = ({ onBack }: { onBack: () => void }) => {
	const [username, setUsername] = useState('');
	const [code, setCode] = useState('');
	const [newPassword, setNewPassword] = useState('');
	const [confirm, setConfirm] = useState('');
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [noRecovery, setNoRecovery] = useState(false);
	const { recoverAccount } = useAuth();
	const { showToast } = useToast();
	const navigate = useNavigate();

	// Native keyboard covers the lower fields; once it's up, pull the focused
	// field into view. The page (Login) provides the scroll room via
	// --keyboard-height. Small delay so the keyboard has started to raise.
	const scrollIntoView = (e: React.FocusEvent<HTMLElement>) => {
		const el = e.currentTarget;
		setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 100);
	};

	const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError(null);
		setNoRecovery(false);
		if (newPassword.length < 8) {
			setError('Your new password needs to be at least 8 characters.');
			return;
		}
		if (newPassword !== confirm) {
			setError('Those two passwords don’t match.');
			return;
		}
		setLoading(true);
		try {
			const result = await recoverAccount(username.trim(), code, newPassword);
			if (result === 'no-recovery') {
				setNoRecovery(true);
				return;
			}
			if (result === 'wrong-code') {
				setError('That recovery code isn’t right. Check the words and their order.');
				return;
			}
			showToast('You’re back in. Your identity and contacts were restored.', 'success');
			navigate('/chat');
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Could not recover your account.');
		} finally {
			setLoading(false);
		}
	};

	return (
		<form onSubmit={handleSubmit} className="space-y-5">
			<button
				type="button"
				onClick={onBack}
				className="flex items-center gap-1 text-sm text-graphite-60 hover:text-graphite transition-colors"
			>
				<ArrowLeft className="w-4 h-4" /> Back to login
			</button>

			<div>
				<h2 className="font-display text-lg font-bold text-graphite">Enter your recovery code</h2>
				<p className="text-sm text-graphite-60 mt-1">
					This is the only way back into your account. Enter the recovery code you saved when you turned this on, and set a
					new password. Your identity and contacts come back — messages that were only on your old phone don’t.
				</p>
			</div>

			<div>
				<label htmlFor="rec-username" className="block text-sm font-medium text-graphite mb-2">
					Username
				</label>
				<div className="relative">
					<User className="absolute left-3 top-1/2 -translate-y-1/2 text-graphite-40 w-5 h-5" />
					<input
						id="rec-username"
						type="text"
						autoComplete="username"
						value={username}
						onChange={(e) => setUsername(e.target.value)}
						placeholder="yourhandle"
						className="w-full pl-10 pr-4 py-2 border border-crease-line-bold rounded-lg bg-inset text-graphite placeholder-graphite-40 font-mono focus:outline-none focus:ring-2 focus:ring-crease"
						disabled={loading}
					/>
				</div>
			</div>

			<div>
				<label htmlFor="rec-code" className="block text-sm font-medium text-graphite mb-2">
					Recovery code
				</label>
				<div className="relative">
					<KeyRound className="absolute left-3 top-3 text-graphite-40 w-5 h-5" />
					<textarea
						id="rec-code"
						value={code}
						onChange={(e) => setCode(e.target.value)}
						onFocus={scrollIntoView}
						placeholder="twelve words, in order"
						rows={3}
						autoCapitalize="none"
						autoCorrect="off"
						spellCheck={false}
						className="w-full pl-10 pr-4 py-2 border border-crease-line-bold rounded-lg bg-inset text-graphite placeholder-graphite-40 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-crease resize-none"
						disabled={loading}
					/>
				</div>
			</div>

			<div>
				<label htmlFor="rec-new" className="block text-sm font-medium text-graphite mb-2">
					New password
				</label>
				<div className="relative">
					<Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-graphite-40 w-5 h-5" />
					<input
						id="rec-new"
						type="password"
						autoComplete="new-password"
						value={newPassword}
						onChange={(e) => setNewPassword(e.target.value)}
						onFocus={scrollIntoView}
						placeholder="••••••••"
						className="w-full pl-10 pr-4 py-2 border border-crease-line-bold rounded-lg bg-inset text-graphite placeholder-graphite-40 focus:outline-none focus:ring-2 focus:ring-crease"
						disabled={loading}
					/>
				</div>
			</div>

			<div>
				<label htmlFor="rec-confirm" className="block text-sm font-medium text-graphite mb-2">
					Confirm new password
				</label>
				<div className="relative">
					<Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-graphite-40 w-5 h-5" />
					<input
						id="rec-confirm"
						type="password"
						autoComplete="new-password"
						value={confirm}
						onChange={(e) => setConfirm(e.target.value)}
						onFocus={scrollIntoView}
						placeholder="••••••••"
						className="w-full pl-10 pr-4 py-2 border border-crease-line-bold rounded-lg bg-inset text-graphite placeholder-graphite-40 focus:outline-none focus:ring-2 focus:ring-crease"
						disabled={loading}
					/>
				</div>
			</div>

			{error && <p className="text-sm text-crane-ink">{error}</p>}
			{noRecovery && (
				<p className="text-sm text-graphite-60">
					No recovery code for that account? Then there’s no way back into this one, by design. You can start fresh with a
					new account.
				</p>
			)}

			<button
				type="submit"
				disabled={loading || !username || !code || !newPassword || !confirm}
				className="w-full bg-crane text-white py-2 px-4 rounded-lg hover:bg-crane-dark focus:outline-none focus:ring-2 focus:ring-crane-ink disabled:opacity-50 transition-colors font-medium"
			>
				{loading ? 'Recovering…' : 'Recover my account'}
			</button>
		</form>
	);
};
