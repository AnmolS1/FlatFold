import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { LoginForm } from '../components/auth/LoginForm';
import { SignupForm } from '../components/auth/SignupForm';
import { RecoverForm } from '../components/auth/RecoverForm';
import { LogoMark } from '../components/common/Brand';
import { LogoHomeLink } from '../components/common/LogoHomeLink';
import { ThemeToggle } from '../components/common/ThemeToggle';
import { useAuth } from '../hooks/useAuth';
import { useKeyboardInset } from '../hooks/useKeyboardInset';

type Tab = 'login' | 'signup';

export const Login = () => {
	const [activeTab, setActiveTab] = useState<Tab>('login');
	const [searchParams] = useSearchParams();
	// `?recover=1` opens the recovery form straight away — the unlock gate's
	// "Forgot your password?" sends the user here.
	const [recovering, setRecovering] = useState(searchParams.get('recover') === '1');
	const { username, loading, keystoreLocked } = useAuth();
	const navigate = useNavigate();
	// Native: expose the keyboard height so the card can add scroll room for
	// fields the keyboard would otherwise cover (notably the recover form).
	useKeyboardInset();

	// Bounce to the chat only when the session is BOTH signed in and unlocked.
	// While the keystore is locked this page is the escape hatch (sign in as
	// someone else, or recover a forgotten password) — redirecting then would
	// trap the user in the unlock gate with no way to switch accounts.
	useEffect(() => {
		if (!loading && username && !keystoreLocked) {
			navigate('/chat');
		}
	}, [username, loading, keystoreLocked, navigate]);

	if (loading) {
		return (
			<div className="flex flex-col items-center justify-center gap-4 min-h-dvh">
				<LogoMark size={48} className="animate-pulse" />
			</div>
		);
	}

	return (
		// min-h-dvh + overflow-y-auto + `m-auto` on the child: the card centers when
		// it fits and scrolls FULLY when it doesn't (unlike `justify-center`, which
		// clips the overflow top). The keyboard-height bottom padding gives the
		// covered fields somewhere to scroll to when the native keyboard is up.
		<div className="min-h-dvh overflow-y-auto flex flex-col p-4">
			{/* Clear the status bar / Dynamic Island via the safe-area inset (0 on web
			    → falls back to the top margin). */}
			<div className="fixed right-4 z-10" style={{ top: 'max(1rem, calc(env(safe-area-inset-top) + 0.25rem))' }}>
				<ThemeToggle />
			</div>
			<div className="max-w-md w-full m-auto" style={{ paddingBottom: 'var(--keyboard-height, 0px)' }}>
				{/* Logo/Header */}
				<div className="text-center mb-8">
					<div className="flex justify-center mb-4">
						<LogoHomeLink height={48} />
					</div>
					<p className="text-graphite-60">A private messenger, end-to-end.</p>
				</div>

				{/* Auth Card */}
				<div className="bg-graph-card border border-crease-line rounded-2xl shadow-[var(--shadow-card)] p-8">
					{recovering ? (
						<RecoverForm onBack={() => setRecovering(false)} />
					) : (
						<>
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

							{activeTab === 'login' && (
								<button
									onClick={() => setRecovering(true)}
									className="mt-4 w-full text-center text-sm text-crease hover:text-crane-ink transition-colors"
								>
									Forgot your password?
								</button>
							)}
						</>
					)}
				</div>

				{/* Footer */}
				<p className="text-center text-sm text-graphite-40 mt-6 font-mono">
					usernames, registration dates, and public keys only — nothing else.
				</p>
				<p className="text-center mt-2">
					<Link to="/transparency" className="text-xs text-crease hover:text-crane-ink transition-colors underline">
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
