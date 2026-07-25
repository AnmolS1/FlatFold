// Regression: the keystore unlock gate must never be a trap.
//
// The bug: a valid server session keeps `username` set while the LOCAL keystore
// is locked, so /login redirected straight back to /chat → the unlock gate. A
// user who forgot that account's password had no way to switch accounts or start
// recovery — the only exit was the destructive panic wipe.
//
// Two invariants pinned here:
//   1. Login must NOT auto-redirect to /chat while the keystore is locked (it is
//      the escape hatch), but MUST redirect once unlocked (the normal path).
//   2. The gate itself must offer recovery + sign-in-as-someone-else, and
//      signing out must actually drop the session.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthContext } from '../src/hooks/useAuth';
import { ThemeProvider } from '../src/contexts/ThemeContext';
import type { AuthContextType } from '../src/types';

// The auth forms and the keystore are irrelevant here — this is about routing
// and the gate's affordances, so keep them inert and deterministic.
vi.mock('../src/components/auth/LoginForm', () => ({ LoginForm: () => <div>login-form</div> }));
vi.mock('../src/components/auth/SignupForm', () => ({ SignupForm: () => <div>signup-form</div> }));
vi.mock('../src/components/auth/RecoverForm', () => ({ RecoverForm: () => <div>recover-form</div> }));
vi.mock('../src/keystore', () => ({ isBiometricEnrolled: vi.fn().mockResolvedValue(false) }));
vi.mock('../src/lib/panicWipe', () => ({ requestPanicWipe: vi.fn() }));

import { Login } from '../src/pages/Login';
import { KeystoreUnlockGate } from '../src/components/KeystoreUnlockGate';

const baseAuth: AuthContextType = {
	username: 'leo',
	loading: false,
	keystoreLocked: true,
	signup: vi.fn(),
	login: vi.fn(),
	logout: vi.fn(),
	unlockKeystore: vi.fn(),
	unlockWithBiometric: vi.fn(),
	changePassword: vi.fn(),
	enrollRecovery: vi.fn(),
	recoverAccount: vi.fn(),
};

function renderAt(path: string, auth: Partial<AuthContextType>) {
	const value = { ...baseAuth, ...auth };
	render(
		<ThemeProvider>
			<AuthContext.Provider value={value}>
				<MemoryRouter initialEntries={[path]}>
					<Routes>
						<Route path="/login" element={<Login />} />
						<Route path="/chat" element={<div>CHAT VIEW</div>} />
					</Routes>
				</MemoryRouter>
			</AuthContext.Provider>
		</ThemeProvider>
	);
	return value;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('unlock gate is not a trap', () => {
	it('does NOT redirect /login → /chat while the keystore is locked', async () => {
		renderAt('/login', { username: 'leo', keystoreLocked: true });
		// The login form stays reachable; we are not bounced to the chat.
		expect(await screen.findByText('login-form')).toBeTruthy();
		expect(screen.queryByText('CHAT VIEW')).toBeNull();
	});

	it('DOES redirect /login → /chat once signed in and unlocked', async () => {
		renderAt('/login', { username: 'leo', keystoreLocked: false });
		await waitFor(() => expect(screen.getByText('CHAT VIEW')).toBeTruthy());
	});

	it('opens the recovery form directly from ?recover=1', async () => {
		renderAt('/login?recover=1', { username: 'leo', keystoreLocked: true });
		expect(await screen.findByText('recover-form')).toBeTruthy();
	});

	it('offers recovery and another-account sign-in on the gate, and signing out drops the session', async () => {
		const logout = vi.fn().mockResolvedValue(undefined);
		render(
			<ThemeProvider>
				<AuthContext.Provider value={{ ...baseAuth, keystoreLocked: true, logout }}>
					<MemoryRouter initialEntries={['/chat']}>
						<KeystoreUnlockGate>
							<div>UNLOCKED CONTENT</div>
						</KeystoreUnlockGate>
					</MemoryRouter>
				</AuthContext.Provider>
			</ThemeProvider>
		);

		// Locked: the protected content is withheld...
		expect(screen.queryByText('UNLOCKED CONTENT')).toBeNull();
		// ...but there is a way OUT that isn't the panic wipe.
		expect(screen.getByText('Forgot your password?')).toBeTruthy();
		const switchAccount = screen.getByText(/Not leo\?/);

		await userEvent.click(switchAccount);
		await waitFor(() => expect(logout).toHaveBeenCalled());
	});

	it('renders children once the keystore is unlocked', () => {
		render(
			<ThemeProvider>
				<AuthContext.Provider value={{ ...baseAuth, keystoreLocked: false }}>
					<MemoryRouter initialEntries={['/chat']}>
						<KeystoreUnlockGate>
							<div>UNLOCKED CONTENT</div>
						</KeystoreUnlockGate>
					</MemoryRouter>
				</AuthContext.Provider>
			</ThemeProvider>
		);
		expect(screen.getByText('UNLOCKED CONTENT')).toBeTruthy();
	});
});
