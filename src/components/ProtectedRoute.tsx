import { Navigate } from 'react-router';
import { LogoMark } from './common/Brand';
import { KeystoreUnlockGate } from './KeystoreUnlockGate';
import { PanicWipe } from './PanicWipe';
import { useAuth } from '../hooks/useAuth';

interface ProtectedRouteProps {
	children: React.ReactNode;
}

export const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
	const { username, loading } = useAuth();

	if (loading) {
		// Branded, spinner-free loading: the mark breathes while the session
		// restores (prefers-reduced-motion collapses the pulse via the global reset).
		return (
			<div className="flex flex-col items-center justify-center gap-4 min-h-dvh bg-graph">
				<LogoMark size={48} className="animate-pulse" />
			</div>
		);
	}

	if (!username) {
		return <Navigate to="/login" replace />;
	}

	// PanicWipe sits OUTSIDE the unlock gate so its chord + confirm dialog work
	// even while the keystore is locked (the gate otherwise renders only its
	// own unlock screen). The wipe itself is key-independent.
	return (
		<>
			<PanicWipe />
			<KeystoreUnlockGate>{children}</KeystoreUnlockGate>
		</>
	);
};
