// `useSyncExternalStore` requires getSnapshot to return a CACHED value. A store
// that builds a fresh object each call looks like "changed" on every render, so
// React re-renders forever and the whole chat lands in the ErrorBoundary —
// which is exactly what shipped: "Something broke", and no chat at all.
//
// This is the regression test for that. It is a reference-identity check, not a
// value check, because value equality is precisely what does NOT save you here.
import { describe, expect, it, beforeEach, vi } from 'vitest';

beforeEach(() => vi.resetModules());

describe('shared player snapshot', () => {
	it('returns the SAME object reference while nothing has changed', async () => {
		const { sharedPlayerState } = await import('../src/lib/audioPlayer');
		const a = sharedPlayerState();
		const b = sharedPlayerState();
		const c = sharedPlayerState();
		// Object.is is what useSyncExternalStore uses to decide "did it change".
		expect(Object.is(a, b)).toBe(true);
		expect(Object.is(b, c)).toBe(true);
	});

	it('still reports a coherent idle state', async () => {
		const { sharedPlayerState } = await import('../src/lib/audioPlayer');
		const s = sharedPlayerState();
		expect(s.url).toBeNull();
		expect(s.playing).toBe(false);
		expect(s.currentTime).toBe(0);
		expect(s.duration).toBe(0);
	});

	it('hands out a new reference only after the state actually changes', async () => {
		const { sharedPlayerState, toggleSharedPlayback } = await import('../src/lib/audioPlayer');
		const before = sharedPlayerState();
		// jsdom has no real audio pipeline; play() rejecting is fine and must not
		// stop the store from recording which note is loaded.
		await toggleSharedPlayback('blob:one').catch(() => {});
		const after = sharedPlayerState();
		expect(after.url).toBe('blob:one');
		expect(Object.is(before, after)).toBe(false);
		// ...and stable again once settled.
		expect(Object.is(sharedPlayerState(), sharedPlayerState())).toBe(true);
	});
});
