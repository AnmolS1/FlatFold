// Voice notes were recorded in whatever container the browser felt like, and
// that is not a cosmetic difference: `new MediaRecorder(stream)` with no
// mimeType gives Chrome and Firefox `audio/webm;codecs=opus`, and **Safari and
// WKWebView cannot decode or play WebM at all**.
//
// So every voice note recorded in desktop Chrome has been unplayable on every
// Apple device — iPhone included, in the shipped app. It surfaced on a Mac, but
// it was never a Mac bug.
//
// There is no container every browser can both record AND play, so the rule is:
// prefer one Apple can play, because Apple is the side that cannot fall back.
// MP4/AAC plays everywhere and Safari records it natively; Chrome records it on
// recent versions. Firefox can only produce Opus, so a Firefox-recorded note
// stays unplayable on Apple — that residual is real and the sender is told,
// rather than it failing silently on the receiver.
import { describe, expect, it } from 'vitest';
import { APPLE_PLAYABLE, pickRecordingMimeType, isApplePlayable } from '../src/lib/audioFormat';

/** Stand-in for MediaRecorder.isTypeSupported with a given support set. */
const supporting = (...types: string[]) => (t: string) => types.some((s) => t.startsWith(s));

describe('pickRecordingMimeType', () => {
	it('prefers MP4 when the browser can record it (Safari, recent Chrome)', () => {
		const picked = pickRecordingMimeType(supporting('audio/mp4', 'audio/webm'));
		expect(picked).toBe('audio/mp4');
		expect(isApplePlayable(picked!)).toBe(true);
	});

	it('falls back to Opus when MP4 is unavailable (Firefox)', () => {
		const picked = pickRecordingMimeType(supporting('audio/ogg', 'audio/webm'));
		expect(picked).not.toBeNull();
		expect(isApplePlayable(picked!)).toBe(false); // the residual, made explicit
	});

	it('returns null when nothing is supported, so the caller can let the browser decide', () => {
		expect(pickRecordingMimeType(() => false)).toBeNull();
	});

	// The bug in one line: the old code passed no mimeType at all, so Chrome
	// chose WebM and Apple devices silently could not play the result.
	it('never picks a WebM container while an Apple-playable one is offered', () => {
		expect(pickRecordingMimeType(supporting('audio/webm', 'audio/mp4'))).not.toContain('webm');
	});

	it('APPLE_PLAYABLE lists only containers Safari actually decodes', () => {
		// WebM and Ogg must never appear here — that is the whole point.
		expect(APPLE_PLAYABLE.some((t) => /webm|ogg/.test(t))).toBe(false);
		expect(APPLE_PLAYABLE.some((t) => t.startsWith('audio/mp4'))).toBe(true);
	});
});

describe('isApplePlayable', () => {
	it.each([
		['audio/mp4', true],
		['audio/mp4;codecs=mp4a.40.2', true],
		['audio/aac', true],
		['audio/webm;codecs=opus', false],
		['audio/ogg;codecs=opus', false],
		['', false],
	])('%s -> %s', (mime, expected) => {
		expect(isApplePlayable(mime)).toBe(expected);
	});
});

describe('the component actually uses the picker', () => {
	// 145 passing unit assertions prove nothing if MessageInput still calls
	// `new MediaRecorder(stream)` with no options. Same lesson as the theme work.
	it('MessageInput picks a format instead of letting the browser choose', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const src = readFileSync(resolve(process.cwd(), 'src/components/chat/MessageInput.tsx'), 'utf8');
		expect(src).toContain('pickRecordingMimeType');
		// The format must actually be handed to the recorder.
		expect(src).toMatch(/new MediaRecorder\(stream, \{ mimeType \}\)/);
		// A bare `new MediaRecorder(stream)` is allowed ONLY as the
		// nothing-is-supported fallback, i.e. guarded by the picked type.
		const bare = [...src.matchAll(/new MediaRecorder\(\s*stream\s*\)/g)];
		expect(bare).toHaveLength(1);
		expect(src).toMatch(/mimeType \?[\s\S]{0,120}: new MediaRecorder\(\s*stream\s*\)/);
	});
});
