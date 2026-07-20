// Audit §6: a render error in one message shouldn't white-screen the whole app.
//
// React unmounts the entire tree when a render throws and nothing catches it,
// so without a boundary a single malformed message takes the conversation, the
// contact list and the composer with it. On a messenger that also means losing
// the UI that would let you delete the offending message.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from '../src/components/common/ErrorBoundary';

function Boom({ explode }: { explode: boolean }): React.ReactElement {
	if (explode) throw new Error('render blew up');
	return <p>all fine</p>;
}

// React logs caught render errors to console.error; silence it so a passing
// run's output stays pristine.
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => consoleError.mockRestore());

describe('ErrorBoundary', () => {
	it('renders children when nothing throws', () => {
		render(
			<ErrorBoundary>
				<Boom explode={false} />
			</ErrorBoundary>
		);
		expect(screen.getByText('all fine')).toBeTruthy();
	});

	it('catches a render error instead of unmounting the app', () => {
		render(
			<ErrorBoundary>
				<Boom explode />
			</ErrorBoundary>
		);

		// Something useful is on screen rather than a blank document.
		expect(screen.getByRole('alert')).toBeTruthy();
		expect(document.body.textContent?.trim()).not.toBe('');
	});

	it('offers a way out', async () => {
		render(
			<ErrorBoundary>
				<Boom explode />
			</ErrorBoundary>
		);
		// A recover affordance, not a dead end.
		expect(screen.getByRole('button', { name: /reload/i })).toBeTruthy();
	});

	it('does not leak the error message to the screen', async () => {
		// On an E2EE app a thrown error can carry decrypted content or key
		// material in its message. Showing it verbatim would put plaintext on a
		// screen the user may be sharing, and into any screenshot they send.
		render(
			<ErrorBoundary>
				<Boom explode />
			</ErrorBoundary>
		);

		expect(document.body.textContent).not.toContain('render blew up');
	});

	it('recovers in place when the user retries', async () => {
		const user = userEvent.setup();
		// A boundary that only offers a full page reload loses anything typed but
		// unsent, so retrying in place has to work. The flag is flipped explicitly
		// rather than counting renders — React may invoke a render more than once,
		// which makes a counter-based fixture flaky.
		let shouldThrow = true;
		function Flaky() {
			if (shouldThrow) throw new Error('transient');
			return <p>recovered</p>;
		}

		render(
			<ErrorBoundary>
				<Flaky />
			</ErrorBoundary>
		);
		expect(screen.getByRole('alert')).toBeTruthy();

		shouldThrow = false; // whatever was wrong has passed
		await user.click(screen.getByRole('button', { name: /try again/i }));

		expect(screen.getByText('recovered')).toBeTruthy();
	});
});
