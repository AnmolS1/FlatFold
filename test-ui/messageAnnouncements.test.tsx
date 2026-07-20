// Audit §3: a screen-reader user should hear incoming messages arrive.
//
// The naive fix — aria-live on the message list — is worse than nothing: it
// announces the entire history on mount and re-announces on every re-render.
// What's wanted is a polite live region carrying only messages that arrive
// while the conversation is open, and only from the other person (you already
// know what you sent).
import { describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MessageList } from '../src/components/chat/MessageList';
import type { DisplayMessage } from '../shared/types';

const msg = (over: Partial<DisplayMessage> & { id: string }): DisplayMessage => ({
	from: 'bob',
	text: 'hello',
	ts: Date.UTC(2026, 0, 1, 10, 0, 0),
	direction: 'received',
	...over,
});

function renderList(messages: DisplayMessage[]) {
	return render(<MessageList messages={messages} currentUsername="alice" loading={false} />);
}

/** The polite live region, found by role rather than by implementation detail. */
const liveRegion = () => document.querySelector('[aria-live="polite"]');

describe('incoming message announcements', () => {
	it('provides a polite live region', () => {
		renderList([msg({ id: '1' })]);
		expect(liveRegion()).not.toBeNull();
		// Assertive would interrupt whatever the user is reading — a new chat
		// message is not that urgent.
		expect(document.querySelector('[aria-live="assertive"]')).toBeNull();
	});

	it('stays silent on first render so history is not read out', async () => {
		renderList([msg({ id: '1', text: 'old one' }), msg({ id: '2', text: 'old two' })]);

		// Nothing announced: these were already there when the view opened.
		await waitFor(() => expect(liveRegion()?.textContent ?? '').toBe(''));
	});

	it('announces a message that arrives while the conversation is open', async () => {
		const { rerender } = renderList([msg({ id: '1', text: 'first' })]);

		rerender(
			<MessageList
				messages={[msg({ id: '1', text: 'first' }), msg({ id: '2', from: 'bob', text: 'are you there' })]}
				currentUsername="alice"
				loading={false}
			/>
		);

		await waitFor(() => expect(liveRegion()?.textContent).toContain('are you there'));
		// Named, so the user knows who spoke in a group.
		expect(liveRegion()?.textContent).toContain('bob');
	});

	it('does not announce your own sent messages', async () => {
		const { rerender } = renderList([msg({ id: '1', text: 'first' })]);

		rerender(
			<MessageList
				messages={[msg({ id: '1', text: 'first' }), msg({ id: '2', from: 'alice', direction: 'sent', text: 'my own message' })]}
				currentUsername="alice"
				loading={false}
			/>
		);

		await waitFor(() => expect(liveRegion()?.textContent ?? '').not.toContain('my own message'));
	});

	it('describes an attachment instead of announcing empty text', async () => {
		const { rerender } = renderList([msg({ id: '1', text: 'first' })]);

		rerender(
			<MessageList
				messages={[
					msg({ id: '1', text: 'first' }),
					msg({
						id: '2',
						text: '',
						media: { id: 'm', key: 'k', nonce: 'n', digest: 'd', mediaKind: 'image', mimeType: 'image/png', size: 1 },
					}),
				]}
				currentUsername="alice"
				loading={false}
			/>
		);

		await waitFor(() => expect(liveRegion()?.textContent?.toLowerCase()).toContain('attachment'));
	});
});
