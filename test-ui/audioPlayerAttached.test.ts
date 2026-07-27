// `a.play()` neither resolved nor rejected, and the element fired no
// `loadedmetadata` and no `error` — it did nothing at all:
//
//   [web] play tapped
//   [web] play tapped
//   (silence)
//
// The shared player was built with `new Audio()` and never added to the
// document. WebKit does not load a DETACHED media element, so the blob was never
// fetched and no event ever fired. Every per-note <audio> before the shared
// player was real JSX and therefore in the DOM — which is why playback worked
// before it and died the moment the element became detached.
import { describe, expect, it, vi, beforeEach } from 'vitest';

beforeEach(() => vi.resetModules());

describe('the shared audio element lives in the document', () => {
	it('is attached on first use, so WebKit will actually load it', async () => {
		const { toggleSharedPlayback } = await import('../src/lib/audioPlayer');
		await toggleSharedPlayback('blob:one').catch(() => {});
		const el = document.querySelector('audio');
		expect(el).not.toBeNull();
		expect(el!.isConnected).toBe(true);
	});

	it('carries playsinline, which WKWebView needs to play in place', async () => {
		const { toggleSharedPlayback } = await import('../src/lib/audioPlayer');
		await toggleSharedPlayback('blob:one').catch(() => {});
		expect(document.querySelector('audio')!.hasAttribute('playsinline')).toBe(true);
	});

	it('creates exactly ONE element however many notes ask for it', async () => {
		const { toggleSharedPlayback } = await import('../src/lib/audioPlayer');
		await toggleSharedPlayback('blob:one').catch(() => {});
		await toggleSharedPlayback('blob:two').catch(() => {});
		await toggleSharedPlayback('blob:three').catch(() => {});
		expect(document.querySelectorAll('audio')).toHaveLength(1);
	});

	it('does not throw where there is no document', async () => {
		const doc = globalThis.document;
		vi.stubGlobal('document', undefined);
		const { toggleSharedPlayback } = await import('../src/lib/audioPlayer');
		await expect(toggleSharedPlayback('blob:one').catch(() => {})).resolves.toBeUndefined();
		vi.stubGlobal('document', doc);
	});
});
