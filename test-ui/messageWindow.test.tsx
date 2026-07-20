// Audit §4: MessageList rendered every message it was given, so a long history
// meant thousands of DOM nodes — jank and memory on exactly the low-end phones
// this app is meant to work on.
//
// The fix is a capped window with a "load earlier" control rather than a
// virtualization library: no new runtime dependency (this is a security product
// — everything shipped to the client is in the trusted computing base), and it
// composes with the existing fold animation, day separators and scroll-to-bottom
// instead of fighting them.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageList, MESSAGE_WINDOW } from '../src/components/chat/MessageList';
import type { DisplayMessage } from '../shared/types';

const HOUR = 3_600_000;

/** `count` messages, oldest first, each with distinctive text. */
function history(count: number): DisplayMessage[] {
	const base = Date.UTC(2026, 0, 1, 0, 0, 0);
	return Array.from({ length: count }, (_, i) => ({
		id: `m${i}`,
		from: 'bob',
		text: `message-${i}`,
		ts: base + i * HOUR,
		direction: 'received' as const,
	}));
}

const shown = (text: string) => screen.queryByText(text) !== null;
const loadEarlier = () => screen.queryByRole('button', { name: /earlier/i });

describe('message window', () => {
	it('renders everything when the history is short', () => {
		render(<MessageList messages={history(10)} currentUsername="alice" loading={false} />);

		expect(shown('message-0')).toBe(true);
		expect(shown('message-9')).toBe(true);
		// Nothing to load — the control shouldn't be there at all.
		expect(loadEarlier()).toBeNull();
	});

	it('renders only the most recent window of a long history', () => {
		const count = MESSAGE_WINDOW + 200;
		render(<MessageList messages={history(count)} currentUsername="alice" loading={false} />);

		// The newest are present...
		expect(shown(`message-${count - 1}`)).toBe(true);
		expect(shown(`message-${count - MESSAGE_WINDOW}`)).toBe(true);
		// ...and the oldest are not in the DOM at all, which is the point.
		expect(shown('message-0')).toBe(false);
		expect(shown(`message-${count - MESSAGE_WINDOW - 1}`)).toBe(false);
	});

	it('offers a way back through the history', async () => {
		const user = userEvent.setup();
		const count = MESSAGE_WINDOW + 50;
		render(<MessageList messages={history(count)} currentUsername="alice" loading={false} />);

		const button = loadEarlier();
		expect(button).not.toBeNull();
		await user.click(button!);

		// The rest of the history is now reachable, and the control retires.
		expect(shown('message-0')).toBe(true);
		expect(loadEarlier()).toBeNull();
	});

	it('keeps showing the newest messages when a new one arrives mid-history', () => {
		// Regression guard: the window is anchored to the END of the list, so an
		// append must stay visible rather than falling outside it.
		const count = MESSAGE_WINDOW + 20;
		const { rerender } = render(<MessageList messages={history(count)} currentUsername="alice" loading={false} />);

		const withNew = [
			...history(count),
			{ id: 'brand-new', from: 'bob', text: 'just arrived', ts: Date.UTC(2026, 5, 1), direction: 'received' as const },
		];
		rerender(<MessageList messages={withNew} currentUsername="alice" loading={false} />);

		expect(shown('just arrived')).toBe(true);
	});

	it('still announces an incoming message when the history is long', () => {
		// The live region reads from the same message list the window slices, so
		// it could easily regress to announcing nothing on a long conversation.
		const count = MESSAGE_WINDOW + 20;
		const { rerender } = render(<MessageList messages={history(count)} currentUsername="alice" loading={false} />);

		rerender(
			<MessageList
				messages={[
					...history(count),
					{ id: 'x', from: 'bob', text: 'audible', ts: Date.UTC(2026, 5, 1), direction: 'received' as const },
				]}
				currentUsername="alice"
				loading={false}
			/>
		);

		expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain('audible');
	});
});
