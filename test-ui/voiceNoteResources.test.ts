// Voice notes failed "randomly" and came back after an app restart. That pair of
// symptoms is a resource leak, not a codec problem — but the UI said:
//
//   "Can't play this voice note — this device cannot decode the format
//    (audio/mp4;codecs=mp4a.40.2)"
//
// which is the format we deliberately chose BECAUSE Apple can decode it, and
// which other notes in the same conversation played fine. The message sent the
// investigation back toward a codec fix that was already correct.
//
// Cause: VoiceNote built `new AudioContext()` per note, on mount, to draw the
// waveform. WebKit caps concurrent AudioContexts at a small number and the close
// here was fire-and-forget (`void ctx?.close()`), so they accumulated. Once the
// cap was hit, construction threw, the component fell back to the native <audio>
// element, and that surfaced MEDIA_ERR_SRC_NOT_SUPPORTED — which the code read
// as "bad codec".
//
// Two fixes, both pinned here: share ONE context, and stop blaming the format
// for a failure the format cannot explain.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { describeVoiceNotePlaybackError } from '../src/lib/mediaErrors';

describe('describeVoiceNotePlaybackError', () => {
	// The bug in one assertion.
	it('does NOT blame the codec when the format is one Apple demonstrably plays', () => {
		const msg = describeVoiceNotePlaybackError(4, 'audio/mp4;codecs=mp4a.40.2');
		expect(msg).not.toMatch(/cannot decode the format/i);
		expect(msg).toMatch(/resource|reopen|restart/i);
	});

	it('still blames the codec when the format really is Apple-hostile', () => {
		const msg = describeVoiceNotePlaybackError(4, 'audio/webm;codecs=opus');
		expect(msg).toMatch(/cannot decode the format/i);
		expect(msg).toContain('audio/webm;codecs=opus');
	});

	it('distinguishes a download failure from either', () => {
		expect(describeVoiceNotePlaybackError(2, 'audio/mp4;codecs=mp4a.40.2')).toMatch(/could not be loaded/i);
	});

	it('handles an unknown code and a missing mime without throwing', () => {
		expect(() => describeVoiceNotePlaybackError(undefined, undefined)).not.toThrow();
		expect(describeVoiceNotePlaybackError(99, undefined)).toBeTruthy();
	});
});

describe('shared AudioContext', () => {
	beforeEach(() => vi.resetModules());

	it('hands every caller the SAME context, so N notes cannot open N contexts', async () => {
		const ctor = vi.fn(() => ({ close: vi.fn(), state: 'running' }));
		vi.stubGlobal('AudioContext', ctor);
		const { getSharedAudioContext } = await import('../src/lib/audioContext');
		const a = getSharedAudioContext();
		const b = getSharedAudioContext();
		const c = getSharedAudioContext();
		expect(a).toBe(b);
		expect(b).toBe(c);
		expect(ctor).toHaveBeenCalledTimes(1); // the whole point
	});

	it('returns null instead of throwing when the platform has no AudioContext', async () => {
		vi.stubGlobal('AudioContext', undefined);
		vi.stubGlobal('webkitAudioContext', undefined);
		const { getSharedAudioContext } = await import('../src/lib/audioContext');
		expect(getSharedAudioContext()).toBeNull();
	});
});

describe('the component actually uses both', () => {
	it('VoiceNote shares the context and no longer constructs its own', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const src = readFileSync(resolve(process.cwd(), 'src/components/chat/VoiceNote.tsx'), 'utf8');
		expect(src).toContain('getSharedAudioContext');
		expect(src).toContain('describeVoiceNotePlaybackError');
		// A per-note `new AudioContext()` / `new AC()` is exactly the leak.
		expect(src).not.toMatch(/new\s+(AC|AudioContext)\s*\(/);
		// And it must not close the shared context out from under other notes.
		expect(src).not.toMatch(/ctx\?\.close\(\)/);
	});
});
