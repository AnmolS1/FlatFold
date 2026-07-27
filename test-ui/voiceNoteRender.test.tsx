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
import { render, screen, cleanup } from '@testing-library/react';
import { VoiceNote } from '../src/components/chat/VoiceNote';

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

	// The regression that killed playback: an element outside the document never
	// loads in WebKit. In JSX it is attached by construction — assert that.
	it('puts its media element IN THE DOCUMENT', () => {
		const { container } = render(<VoiceNote url="blob:one" durationMs={4200} own={false} />);
		const audio = container.querySelector('audio');
		expect(audio).not.toBeNull();
		expect(audio!.isConnected).toBe(true);
		expect(audio!.getAttribute('src')).toBe('blob:one');
	});

	it('renders exactly ONE media element per note', () => {
		const { container } = render(<VoiceNote url="blob:one" durationMs={4200} own={false} />);
		expect(container.querySelectorAll('audio')).toHaveLength(1);
	});

	it('shows the sender-provided duration without needing the element to load', () => {
		render(<VoiceNote url="blob:one" durationMs={65000} own={false} />);
		expect(screen.getByText('1:05')).toBeTruthy();
	});

	// The render-loop class: if the component re-rendered unboundedly, mounting
	// several would hang or blow the stack rather than settle.
	it('mounting many notes settles instead of looping', () => {
		const { container } = render(
			<>
				{Array.from({ length: 12 }, (_, i) => (
					<VoiceNote key={i} url={`blob:${i}`} durationMs={1000} own={false} />
				))}
			</>
		);
		expect(container.querySelectorAll('audio')).toHaveLength(12);
	});
});
