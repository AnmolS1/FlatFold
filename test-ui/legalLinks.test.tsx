// Audit §2.3 (claim discipline): the privacy policy and terms went live on the
// ponderance site, but nothing in the app pointed at them. A privacy policy
// nobody can find from the product does no work.
//
// The login screen is the right surface: it's the one page every user sees
// before entrusting anything to the app, and it already carries the "what the
// server stores" link, so the disclosure lives in one place.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// Login sits under AuthProvider, which calls GET /api/auth/me on mount. Stub the
// network boundary only — the component under test is otherwise real.
vi.mock('../src/lib/api', () => ({
	apiMe: vi.fn().mockResolvedValue({ status: 'unauthenticated' }),
	apiLogin: vi.fn(),
	apiLogout: vi.fn(),
	apiSignup: vi.fn(),
	apiPublishKeys: vi.fn(),
}));

const { Login } = await import('../src/pages/Login');
const { AuthProvider } = await import('../src/contexts/AuthContext');
// Login pulls in a ThemeToggle (useTheme) and a LoginForm (useToast), so both
// contexts are required. Without them the post-load render throws and every
// query times out rather than failing fast, which reads as "the element is
// missing" when the real cause is that nothing rendered at all.
const { ThemeProvider } = await import('../src/contexts/ThemeContext');
const { ToastProvider } = await import('../src/contexts/ToastContext');

/**
 * These are absolute URLs to a different origin (the ponderance site hosts the
 * legal pages for every service), so they're asserted exactly. The trailing
 * slash is load-bearing: without it the site answers 307 and the user takes a
 * redirect hop to reach a legal document.
 */
const PRIVACY = 'https://ponderance.dev/privacy/';
const TERMS = 'https://ponderance.dev/terms/';

function renderLogin() {
	render(
		<MemoryRouter>
			<ThemeProvider>
				<ToastProvider>
					<AuthProvider>
						<Login />
					</AuthProvider>
				</ToastProvider>
			</ThemeProvider>
		</MemoryRouter>
	);
}

// AuthProvider resolves its session check before rendering children, so every
// query here is the async form — a sync getByRole runs before the form mounts.
describe('legal links on the login screen', () => {
	it('links to the privacy policy', async () => {
		renderLogin();

		const link = await screen.findByRole('link', { name: /privacy/i });
		expect(link.getAttribute('href')).toBe(PRIVACY);
	});

	it('links to the terms', async () => {
		renderLogin();

		const link = await screen.findByRole('link', { name: /terms/i });
		expect(link.getAttribute('href')).toBe(TERMS);
	});

	it('opens them without handing the destination control of this tab', async () => {
		// rel="noopener" on a target=_blank link: without it the opened page gets
		// a window.opener handle back into the app's origin. Cheap to add, easy to
		// forget, and this is a security product.
		renderLogin();

		for (const name of [/privacy/i, /terms/i]) {
			const link = await screen.findByRole('link', { name });
			if (link.getAttribute('target') === '_blank') {
				expect(link.getAttribute('rel')).toContain('noopener');
			}
		}
	});

	it('still shows what the server stores', async () => {
		// Regression guard: the new links sit next to the existing transparency
		// link, so it would be easy to displace it while rearranging the footer.
		renderLogin();

		expect(await screen.findByRole('link', { name: /what the server stores/i })).toBeTruthy();
	});
});
