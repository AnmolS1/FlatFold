// App Review 1.2: the terms gate. Rejection of 1.0 (3) cited guideline 1.2, and
// the first requirement on Apple's checklist is an agreement with no-tolerance
// terms that the user must accept before using the app.
//
// Three things are pinned here, and each one is a way the fix could silently
// stop satisfying the guideline:
//   1. The gate actually WITHHOLDS the app. A gate you can render past is not a
//      gate, and this is the whole claim made in the review notes.
//   2. The no-tolerance sentence is really on screen. The requirement is about
//      the text, not the mechanism — someone softening the wording later would
//      break the commitment without breaking anything that looks like a test.
//   3. It applies even with the keystore LOCKED. Acceptance is a property of the
//      server session; if the unlock gate rendered first, a locked-keystore user
//      would sit in front of a password prompt having agreed to nothing.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { AuthContext } from '../src/hooks/useAuth';
import { ThemeProvider } from '../src/contexts/ThemeContext';
import type { AuthContextType } from '../src/types';

vi.mock('../src/keystore', () => ({
	isBiometricEnrolled: vi.fn().mockResolvedValue(false),
	isPasskeyUnlockEnrolled: vi.fn().mockResolvedValue(false),
}));
// PanicWipe (rendered by ProtectedRoute) subscribes to PANIC_EVENT, so the mock
// has to keep that export or the component throws on mount.
vi.mock('../src/lib/panicWipe', () => ({ PANIC_EVENT: 'flatfold:panic', requestPanicWipe: vi.fn(), panicWipe: vi.fn() }));

import { TermsGate } from '../src/components/TermsGate';
import { ProtectedRoute } from '../src/components/ProtectedRoute';

const baseAuth: AuthContextType = {
	username: 'wren',
	loading: false,
	keystoreLocked: false,
	termsAccepted: false,
	acceptTerms: vi.fn(),
	signup: vi.fn(),
	login: vi.fn(),
	logout: vi.fn(),
	unlockKeystore: vi.fn(),
	unlockWithBiometric: vi.fn(),
	unlockWithPasskey: vi.fn(),
	changePassword: vi.fn(),
	enrollRecovery: vi.fn(),
	recoverAccount: vi.fn(),
};

function renderGate(auth: Partial<AuthContextType>, children = <div>APP SURFACE</div>) {
	render(
		<ThemeProvider>
			<AuthContext.Provider value={{ ...baseAuth, ...auth }}>
				<MemoryRouter initialEntries={['/chat']}>
					<TermsGate>{children}</TermsGate>
				</MemoryRouter>
			</AuthContext.Provider>
		</ThemeProvider>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('terms gate (App Review 1.2)', () => {
	it('withholds the app until the terms are accepted', () => {
		renderGate({ termsAccepted: false });
		expect(screen.queryByText('APP SURFACE')).toBeNull();
	});

	it('renders the app once the terms are accepted', () => {
		renderGate({ termsAccepted: true });
		expect(screen.getByText('APP SURFACE')).toBeTruthy();
	});

	it('states the no-tolerance terms and that offending accounts are terminated', () => {
		renderGate({ termsAccepted: false });
		// Asserted as RENDERED TEXT, not as a constant — a clause that stops being
		// rendered still passes a constant check. The heading carries the phrase too,
		// so this targets the clause paragraph, which states the consequence.
		expect(screen.getByText(/There is no tolerance for objectionable content, and none for abusive users\./i)).toBeTruthy();
		expect(screen.getByText(/Accounts that send it are terminated/i)).toBeTruthy();
	});

	it('agreeing records acceptance on the server', async () => {
		const acceptTerms = vi.fn().mockResolvedValue(undefined);
		renderGate({ termsAccepted: false, acceptTerms });

		await userEvent.click(screen.getByRole('button', { name: 'I agree' }));
		await waitFor(() => expect(acceptTerms).toHaveBeenCalled());
	});

	it('keeps the gate up when the server rejects the acceptance', async () => {
		const acceptTerms = vi.fn().mockRejectedValue(new Error('offline'));
		renderGate({ termsAccepted: false, acceptTerms });

		await userEvent.click(screen.getByRole('button', { name: 'I agree' }));
		await waitFor(() => expect(screen.getByText('offline')).toBeTruthy());
		expect(screen.queryByText('APP SURFACE')).toBeNull();
	});

	it('declining signs out rather than trapping the user', async () => {
		const logout = vi.fn().mockResolvedValue(undefined);
		renderGate({ termsAccepted: false, logout });

		await userEvent.click(screen.getByRole('button', { name: /do not agree/i }));
		await waitFor(() => expect(logout).toHaveBeenCalled());
	});

	it('gates BEFORE the keystore unlock prompt, not after', () => {
		render(
			<ThemeProvider>
				<AuthContext.Provider value={{ ...baseAuth, termsAccepted: false, keystoreLocked: true }}>
					<MemoryRouter initialEntries={['/chat']}>
						<ProtectedRoute>
							<div>APP SURFACE</div>
						</ProtectedRoute>
					</MemoryRouter>
				</AuthContext.Provider>
			</ThemeProvider>
		);
		// The terms, not the password prompt.
		expect(screen.getByText(/There is no tolerance for objectionable content/i)).toBeTruthy();
		expect(screen.queryByText('Unlock this device')).toBeNull();
		expect(screen.queryByText('APP SURFACE')).toBeNull();
	});
});
