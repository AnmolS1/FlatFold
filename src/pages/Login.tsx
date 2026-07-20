import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { LoginForm } from '../components/auth/LoginForm';
import { SignupForm } from '../components/auth/SignupForm';
import { LogoMark } from '../components/common/Brand';
import { LogoHomeLink } from '../components/common/LogoHomeLink';
import { ThemeToggle } from '../components/common/ThemeToggle';
import { useAuth } from '../hooks/useAuth';

type Tab = 'login' | 'signup';

export const Login = () => {
	const [activeTab, setActiveTab] = useState<Tab>('login');
	const { username, loading } = useAuth();
	const navigate = useNavigate();

	useEffect(() => {
		if (!loading && username) {
			navigate('/chat');
		}
	}, [username, loading, navigate]);

	if (loading) {
		return (
			<div className="flex flex-col items-center justify-center gap-4 min-h-dvh">
				<LogoMark size={48} className="animate-pulse" />
			</div>
		);
	}

	return (
		<div className="min-h-screen flex items-center justify-center p-4">
			<div className="absolute top-4 right-4">
				<ThemeToggle />
			</div>
			<div className="max-w-md w-full">
				{/* Logo/Header */}
				<div className="text-center mb-8">
					<div className="flex justify-center mb-4">
						<LogoHomeLink height={48} />
					</div>
					<p className="text-graphite-60">A private messenger, end-to-end.</p>
				</div>

				{/* Auth Card */}
				<div className="bg-graph-card border border-crease-line rounded-2xl shadow-[var(--shadow-card)] p-8">
					{/* Tabs */}
					<div className="flex gap-2 mb-6 bg-inset border border-crease-line p-1 rounded-lg">
						<button
							onClick={() => setActiveTab('login')}
							className={`flex-1 py-2 px-4 rounded-md font-medium transition-colors ${
								activeTab === 'login'
									? 'bg-graph-card text-crease shadow-sm'
									: 'text-graphite-60 hover:text-graphite'
							}`}
						>
							Login
						</button>
						<button
							onClick={() => setActiveTab('signup')}
							className={`flex-1 py-2 px-4 rounded-md font-medium transition-colors ${
								activeTab === 'signup'
									? 'bg-graph-card text-crease shadow-sm'
									: 'text-graphite-60 hover:text-graphite'
							}`}
						>
							Sign Up
						</button>
					</div>

					{/* Forms */}
					{activeTab === 'login' ? <LoginForm /> : <SignupForm />}
				</div>

				{/* Footer */}
				<p className="text-center text-sm text-graphite-40 mt-6 font-mono">
					usernames, registration dates, and public keys only — nothing else.
				</p>
				<p className="text-center mt-2">
					<Link to="/transparency" className="text-xs text-crease hover:text-crane transition-colors underline">
						See exactly what the server stores
					</Link>
				</p>
				{/* The legal pages live on the ponderance site, which hosts them for
				    every service, so these leave the app. rel="noopener" because a
				    target=_blank link otherwise hands the opened page a window.opener
				    handle back into this origin. Trailing slashes are deliberate: the
				    site 307s without them, and a redirect hop to reach a privacy
				    policy is a bad look for a product whose whole pitch is that you
				    can check the claims yourself. */}
				<p className="text-center mt-3 text-xs text-graphite-40">
					<a
						href="https://ponderance.dev/privacy/"
						target="_blank"
						rel="noopener noreferrer"
						className="text-graphite-40 hover:text-graphite-60 transition-colors underline"
					>
						Privacy
					</a>
					<span className="mx-2" aria-hidden="true">
						·
					</span>
					<a
						href="https://ponderance.dev/terms/"
						target="_blank"
						rel="noopener noreferrer"
						className="text-graphite-40 hover:text-graphite-60 transition-colors underline"
					>
						Terms
					</a>
				</p>
			</div>
		</div>
	);
};
