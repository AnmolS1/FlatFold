import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, Lock } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useToast } from '../../hooks/useToast';
import type { FormErrors } from '../../types';

export const SignupForm = () => {
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [errors, setErrors] = useState<FormErrors>({});
	const [loading, setLoading] = useState(false);
	const { signup } = useAuth();
	const { showToast } = useToast();
	const navigate = useNavigate();

	const validateForm = (): boolean => {
		const newErrors: FormErrors = {};

		if (!username) {
			newErrors.username = 'Username is required';
		} else if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
			newErrors.username = '3-32 characters: letters, numbers, underscore';
		}

		if (!password) {
			newErrors.password = 'Password is required';
		} else if (password.length < 8) {
			newErrors.password = 'Password must be at least 8 characters';
		}

		setErrors(newErrors);
		return Object.keys(newErrors).length === 0;
	};

	const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setErrors({});

		if (!validateForm()) {
			return;
		}

		setLoading(true);

		try {
			await signup(username, password);
			showToast('Account created successfully!', 'success');
			navigate('/chat');
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Failed to sign up';
			showToast(errorMessage, 'error');
		} finally {
			setLoading(false);
		}
	};

	return (
		<form onSubmit={handleSubmit} className="space-y-6">
			<div>
				<label htmlFor="new-username" className="block text-sm font-medium text-graphite mb-2">
					Username
				</label>
				<div className="relative">
					<User className="absolute left-3 top-1/2 transform -translate-y-1/2 text-graphite-40 w-5 h-5" />
					<input
						id="new-username"
						type="text"
						autoComplete="username"
						value={username}
						onChange={(e) => setUsername(e.target.value)}
						className={`w-full pl-10 pr-4 py-2 border rounded-lg bg-inset text-graphite placeholder-graphite-40 font-mono focus:outline-none focus:ring-2 focus:ring-crease focus:border-transparent ${
							errors.username ? 'border-crane-ink' : 'border-crease-line-bold'
						}`}
						placeholder="yourhandle"
						disabled={loading}
					/>
				</div>
				{errors.username && <p className="mt-1 text-sm text-crane-ink">{errors.username}</p>}
				<p className="mt-1 text-xs text-graphite-40">No email or phone number — just a username.</p>
			</div>

			<div>
				<label htmlFor="new-password" className="block text-sm font-medium text-graphite mb-2">
					Password
				</label>
				<div className="relative">
					<Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 text-graphite-40 w-5 h-5" />
					<input
						id="new-password"
						type="password"
						autoComplete="new-password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						className={`w-full pl-10 pr-4 py-2 border rounded-lg bg-inset text-graphite placeholder-graphite-40 focus:outline-none focus:ring-2 focus:ring-crease focus:border-transparent ${
							errors.password ? 'border-crane-ink' : 'border-crease-line-bold'
						}`}
						placeholder="••••••••"
						disabled={loading}
					/>
				</div>
				{errors.password && <p className="mt-1 text-sm text-crane-ink">{errors.password}</p>}
			</div>

			<button
				type="submit"
				disabled={loading}
				className="w-full bg-crane text-white py-2 px-4 rounded-lg hover:bg-crane-dark focus:outline-none focus:ring-2 focus:ring-crane-ink focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
			>
				{loading ? (
					<span className="flex items-center justify-center gap-2">
						<div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
						Creating account...
					</span>
				) : (
					'Sign Up'
				)}
			</button>
		</form>
	);
};
