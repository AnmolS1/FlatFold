import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageInput } from '../src/components/chat/MessageInput';

// After sending, the caret used to leave the composer: the textarea had no ref
// and was `disabled` while `sending`, which blurs it (and drops the mobile
// keyboard), with nothing refocusing it afterwards. You had to tap back into
// the box for every message.
//
// These tests pin the two halves of the fix: focus survives a send by either
// route (Enter and the Send button), and the double-submit guard that replaced
// the disabled attribute actually holds.

function setup(onSendMessage: (text: string) => Promise<void>) {
	const user = userEvent.setup();
	render(<MessageInput onSendMessage={onSendMessage} onSendMedia={vi.fn()} />);
	const textarea = screen.getByPlaceholderText('Message');
	return { user, textarea: textarea as HTMLTextAreaElement };
}

describe('MessageInput keeps the composer focused after sending', () => {
	it('clears and refocuses the textarea after sending with Enter', async () => {
		const onSendMessage = vi.fn().mockResolvedValue(undefined);
		const { user, textarea } = setup(onSendMessage);

		await user.click(textarea);
		await user.type(textarea, 'first message');
		await user.keyboard('{Enter}');

		await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('first message'));
		await waitFor(() => expect(textarea.value).toBe(''));
		expect(document.activeElement).toBe(textarea);
	});

	it('never lets the Send tap take focus off the textarea', async () => {
		// The mobile-keyboard case. The refocus in handleSubmit lands after
		// `await onSendMessage(...)`, outside the user-gesture context, which is
		// enough for desktop but will not reopen the iOS keyboard. So the tap
		// itself must not move focus: the button preventDefaults its pointerdown.
		// Asserted mid-gesture — between pointer down and up — because that is
		// where the blur would happen.
		const onSendMessage = vi.fn().mockResolvedValue(undefined);
		const { user, textarea } = setup(onSendMessage);

		await user.click(textarea);
		await user.type(textarea, 'keyboard stays up');

		const sendButton = screen.getByLabelText('Send message');
		await user.pointer({ keys: '[MouseLeft>]', target: sendButton }); // press, no release
		expect(document.activeElement).toBe(textarea);

		await user.pointer({ keys: '[/MouseLeft]', target: sendButton }); // release
		await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('keyboard stays up'));
		expect(document.activeElement).toBe(textarea);
	});

	it('refocuses the textarea after sending via the Send button', async () => {
		// The button is the case that actually needs the explicit focus() call:
		// clicking it moves focus to the button, away from the composer.
		const onSendMessage = vi.fn().mockResolvedValue(undefined);
		const { user, textarea } = setup(onSendMessage);

		await user.type(textarea, 'sent by button');
		await user.click(screen.getByLabelText('Send message'));

		await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('sent by button'));
		await waitFor(() => expect(textarea.value).toBe(''));
		expect(document.activeElement).toBe(textarea);
	});

	it('never disables the textarea mid-send, so focus and the keyboard are not dropped', async () => {
		// Disabling the field is what blurred it. Hold the send open and assert
		// the textarea stays enabled and focused for the whole in-flight window.
		let release!: () => void;
		const inFlight = new Promise<void>((resolve) => {
			release = resolve;
		});
		const onSendMessage = vi.fn().mockReturnValue(inFlight);
		const { user, textarea } = setup(onSendMessage);

		await user.click(textarea);
		await user.type(textarea, 'slow send');
		await user.keyboard('{Enter}');

		await waitFor(() => expect(onSendMessage).toHaveBeenCalledTimes(1));
		expect(textarea.disabled).toBe(false);
		expect(document.activeElement).toBe(textarea);

		release();
		await waitFor(() => expect(textarea.value).toBe(''));
		expect(document.activeElement).toBe(textarea);
	});

	it('can send several messages in a row without re-focusing by hand', async () => {
		const onSendMessage = vi.fn().mockResolvedValue(undefined);
		const { user, textarea } = setup(onSendMessage);

		await user.click(textarea);
		for (const text of ['one', 'two', 'three']) {
			// No click between sends — the caret must already be in the box.
			await user.keyboard(text);
			await user.keyboard('{Enter}');
			await waitFor(() => expect(textarea.value).toBe(''));
		}

		expect(onSendMessage.mock.calls.map(([t]) => t)).toEqual(['one', 'two', 'three']);
		expect(document.activeElement).toBe(textarea);
	});
});

describe('MessageInput double-submit guard', () => {
	it('sends once when the form is submitted twice synchronously', async () => {
		// The real threat, and the reason the guard is a ref rather than the
		// `sending` state: both submits run before React re-renders, so they
		// would both read `sending === false` from the same closure.
		let release!: () => void;
		const inFlight = new Promise<void>((resolve) => {
			release = resolve;
		});
		const onSendMessage = vi.fn().mockReturnValue(inFlight);
		const { user, textarea } = setup(onSendMessage);

		await user.type(textarea, 'only once');
		const form = textarea.closest('form');
		if (!form) throw new Error('Expected the textarea to be inside a form');

		form.requestSubmit();
		form.requestSubmit();

		await waitFor(() => expect(onSendMessage).toHaveBeenCalledTimes(1));
		release();
		await waitFor(() => expect(textarea.value).toBe(''));
		expect(onSendMessage).toHaveBeenCalledTimes(1);
	});

	it('allows the next send once the in-flight one settles', async () => {
		// The guard must clear in `finally` — otherwise it wedges the composer.
		const onSendMessage = vi.fn().mockResolvedValue(undefined);
		const { user, textarea } = setup(onSendMessage);

		await user.type(textarea, 'first');
		await user.keyboard('{Enter}');
		await waitFor(() => expect(textarea.value).toBe(''));

		await user.keyboard('second');
		await user.keyboard('{Enter}');
		await waitFor(() => expect(onSendMessage).toHaveBeenCalledTimes(2));
		expect(onSendMessage.mock.calls.map(([t]) => t)).toEqual(['first', 'second']);
	});

	it('clears the guard after a failed send so the user can retry', async () => {
		const onSendMessage = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
		const { user, textarea } = setup(onSendMessage);

		await user.type(textarea, 'retry me');
		await user.keyboard('{Enter}');
		await screen.findByText('offline');
		// The text is preserved on failure, so a retry resends it.
		expect(textarea.value).toBe('retry me');

		await user.keyboard('{Enter}');
		await waitFor(() => expect(onSendMessage).toHaveBeenCalledTimes(2));
	});
});
