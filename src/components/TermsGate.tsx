import { useState, type ReactNode } from 'react';
import { LogoMark } from './common/Brand';
import { useAuth } from '../hooks/useAuth';
import { TERMS_SECTIONS } from '../../shared/terms';

interface TermsGateProps {
	children: ReactNode;
}

// App Review 1.2: every account must agree to terms stating there is no
// tolerance for objectionable content or abusive users, before the app is
// usable.
//
// WHY A GATE COMPONENT AND NOT A /terms ROUTE: the router already sends `*` to
// /chat, so a redirect-based gate would be fighting it, and any new route is one
// more surface that has to remember to re-check. Composed here, "after sign-in,
// before the chat surface" holds by construction. It sits OUTSIDE
// KeystoreUnlockGate because acceptance is a property of the SERVER session, not
// of the local keystore — someone with a locked keystore has still signed in,
// and must still agree before going further.
//
// The only way past it is Agree. Declining signs you out, which is what
// declining an agreement has to mean.
export const TermsGate = ({ children }: TermsGateProps) => {
	const { termsAccepted, acceptTerms, logout } = useAuth();
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (termsAccepted) return <>{children}</>;

	const handleAgree = async () => {
		setError(null);
		setSubmitting(true);
		try {
			await acceptTerms();
		} catch (err) {
			// The gate stays up — `acceptTerms` only flips local state after the
			// server has actually recorded it.
			setError(err instanceof Error ? err.message : 'Could not save that. Please try again.');
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="min-h-dvh flex items-center justify-center p-4 bg-graph">
			<div className="max-w-lg w-full flex flex-col max-h-dvh py-4">
				<div className="flex justify-center mb-4 shrink-0">
					<LogoMark size={40} />
				</div>
				<h1 className="font-display text-xl font-bold text-graphite text-center mb-2 shrink-0">
					Before you start
				</h1>
				<p className="text-graphite-60 text-sm text-center mb-4 shrink-0">
					Please read and agree to the terms of use.
				</p>

				{/* The terms themselves scroll INSIDE this box rather than the page, so
				    the Agree button never scrolls out of reach on a short screen. */}
				<div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-crease-line-bold bg-inset px-4 py-4 text-sm text-graphite space-y-5">
					{TERMS_SECTIONS.map((section) => (
						<section key={section.heading}>
							<h2 className="font-display font-bold text-graphite mb-1">{section.heading}</h2>
							{section.body.map((paragraph) => (
								<p key={paragraph} className="text-graphite-60 mb-2 last:mb-0">
									{paragraph}
								</p>
							))}
						</section>
					))}
				</div>

				{error && <p className="text-sm text-crane-ink mt-3 shrink-0">{error}</p>}

				<div className="mt-4 shrink-0">
					<button
						onClick={() => void handleAgree()}
						disabled={submitting}
						className="w-full bg-crane text-white px-4 py-2 rounded-lg hover:bg-crane-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
					>
						{submitting ? 'Saving…' : 'I agree'}
					</button>
					<button
						onClick={() => void logout()}
						className="w-full mt-2 text-sm text-graphite-60 hover:text-graphite transition-colors py-2"
					>
						I do not agree — sign out
					</button>
				</div>
			</div>
		</div>
	);
};
