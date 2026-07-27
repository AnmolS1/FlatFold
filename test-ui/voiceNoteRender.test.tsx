// Actually RENDER the component.
//
// Two of this component's worst bugs were invisible to unit tests and shipped to
// a device: a `useSyncExternalStore` snapshot that was not cached, which
// re-rendered forever and took the whole app into the ErrorBoundary; and a media
// element that was never in the document, so playback died silently. 700 passing
// unit tests said nothing about either.
//
// A render test sees both.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { VoiceNote, LIVE_NOTE_LIMIT } from '../src/components/chat/VoiceNote';

beforeEach(() => {
	// jsdom has no media pipeline; these only need to exist, not work.
	vi.stubGlobal('fetch', async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }));
	Object.defineProperty(HTMLMediaElement.prototype, 'play', {
		configurable: true,
		value: vi.fn().mockResolvedValue(undefined),
	});
	Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: vi.fn() });
});
afterEach(cleanup);

describe('VoiceNote renders', () => {
	it('mounts without throwing and shows a play control', () => {
		render(<VoiceNote url="blob:one" durationMs={4200} own={false} />);
		expect(screen.getByLabelText(/play voice note/i)).toBeTruthy();
	});

	// WebKit's ceiling is on MEDIA ELEMENTS, not on loaded resources. Measured on
	// Mac Catalyst: a conversation with 37 voice notes rendered 37 <audio>
	// elements, 31 reached readyState 1 and the last 6 sat at networkState 2 /
	// readyState 0 forever with `error` null.
	//
	// This is why withholding `src` from all 37 elements did nothing — the
	// elements themselves had already consumed the budget. The element must not
	// EXIST until the note is played.
	it('renders NO media element until the note is played', () => {
		const { container } = render(<VoiceNote url="blob:one" durationMs={4200} own={false} />);
		expect(container.querySelector('audio')).toBeNull();
	});

	it('creates the media element, with its source, on the play gesture', () => {
		const { container } = render(<VoiceNote url="blob:one" durationMs={4200} own={false} />);
		fireEvent.click(screen.getByLabelText(/play voice note/i));
		const audio = container.querySelector('audio');
		expect(audio).not.toBeNull();
		expect(audio!.getAttribute('src')).toBe('blob:one');
		// Still attached by construction: a DETACHED element never loads in
		// WebKit, which is its own separately-paid-for lesson.
		expect(audio!.isConnected).toBe(true);
	});

	// The cap is the actual fix. Without it a long session ends up back at the
	// ceiling, just more slowly.
	it('keeps the number of live media elements bounded', () => {
		const { container } = render(
			<>
				{Array.from({ length: 20 }, (_, i) => (
					<VoiceNote key={i} url={`blob:${i}`} durationMs={1000} own={false} />
				))}
			</>
		);
		for (const button of screen.getAllByLabelText(/play voice note/i)) fireEvent.click(button);
		expect(container.querySelectorAll('audio').length).toBeLessThanOrEqual(LIVE_NOTE_LIMIT);
	});

	// Retiring an element to reclaim budget removes it from the DOM, so no
	// `pause` event ever fires. Without an explicit reset the component stays in
	// its playing state forever: the control keeps offering "Pause" for a note
	// that is not playing and no longer has an element to pause.
	it('resets to a playable state when its element is retired for budget', () => {
		render(
			<>
				{Array.from({ length: LIVE_NOTE_LIMIT + 1 }, (_, i) => (
					<VoiceNote key={i} url={`blob:${i}`} durationMs={1000} own={false} />
				))}
			</>
		);
		const buttons = () => screen.getAllByLabelText(/(play|pause) voice note/i);
		// Play the first note and let it report that it started.
		fireEvent.click(buttons()[0]);
		fireEvent.play(document.querySelector('audio')!);
		expect(screen.getByLabelText(/pause voice note/i)).toBeTruthy();

		// Fill the budget so the first note is the one retired.
		for (let i = 1; i <= LIVE_NOTE_LIMIT; i++) fireEvent.click(buttons()[i]);

		expect(screen.queryByLabelText(/pause voice note/i)).toBeNull();
	});

	it('renders exactly ONE media element per played note', () => {
		const { container } = render(<VoiceNote url="blob:one" durationMs={4200} own={false} />);
		fireEvent.click(screen.getByLabelText(/play voice note/i));
		expect(container.querySelectorAll('audio')).toHaveLength(1);
	});

	it('shows the sender-provided duration without needing the element to load', () => {
		render(<VoiceNote url="blob:one" durationMs={65000} own={false} />);
		expect(screen.getByText('1:05')).toBeTruthy();
	});

	// The render-loop class: if the component re-rendered unboundedly, mounting
	// several would hang or blow the stack rather than settle.
	it('mounting many notes settles instead of looping', () => {
		render(
			<>
				{Array.from({ length: 12 }, (_, i) => (
					<VoiceNote key={i} url={`blob:${i}`} durationMs={1000} own={false} />
				))}
			</>
		);
		expect(screen.getAllByLabelText(/play voice note/i)).toHaveLength(12);
	});
});
