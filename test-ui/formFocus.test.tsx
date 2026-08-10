// Tab from Username to Password on the login form.
//
// This is browser-default behaviour everywhere EXCEPT Mac Catalyst, where the
// web content sits inside UIKit and its focus system claims Tab before the DOM
// sees it — so on macOS the key did nothing and you had to click into the
// password field. Typing worked, which is what made it confusing to diagnose:
// key events reach the field, just not that one.
//
// jsdom cannot reproduce the Catalyst focus engine, so this does NOT prove the
// macOS fix — only a real Mac build does, and that is in the test plan. What it
// pins is that the handler moves focus deterministically rather than deferring
// to the host, which is the property the fix depends on.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { ThemeProvider } from '../src/contexts/ThemeContext';
import { ToastProvider } from '../src/contexts/ToastContext';
import { AuthContext } from '../src/hooks/useAuth';
import type { AuthContextType } from '../src/types';
import { LoginForm } from '../src/components/auth/LoginForm';

const auth: AuthContextType = {
	username: null,
	loading: false,
	keystoreLocked: false,
	termsAccepted: true,
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

function renderLogin() {
	render(
		<ThemeProvider>
			<ToastProvider>
				<AuthContext.Provider value={auth}>
					<MemoryRouter initialEntries={['/login']}>
						<LoginForm />
					</MemoryRouter>
				</AuthContext.Provider>
			</ToastProvider>
		</ThemeProvider>
	);
}

describe('login form tab order', () => {
	it('Tab moves from username to password', async () => {
		renderLogin();
		const username = document.getElementById('username') as HTMLInputElement;
		const password = document.getElementById('password') as HTMLInputElement;

		username.focus();
		expect(document.activeElement).toBe(username);

		await userEvent.keyboard('{Tab}');
		expect(document.activeElement).toBe(password);
	});

	it('Shift+Tab moves back from password to username', async () => {
		renderLogin();
		const username = document.getElementById('username') as HTMLInputElement;
		const password = document.getElementById('password') as HTMLInputElement;

		password.focus();
		await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
		expect(document.activeElement).toBe(username);
	});

	it('still types normally — the handler must not swallow ordinary keys', async () => {
		renderLogin();
		const username = document.getElementById('username') as HTMLInputElement;
		username.focus();
		await userEvent.keyboard('wren');
		expect(username.value).toBe('wren');
		expect(screen.getByLabelText(/username/i)).toBeTruthy();
	});
});
