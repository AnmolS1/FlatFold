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
		expect(picked).toBe('audio/mp4;codecs=mp4a.40.2');
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

	// The trap that made the first version of this fix useless. Chrome reports
	// BOTH `audio/mp4` and `audio/mp4;codecs=opus` as recordable, and a bare
	// `audio/mp4` lets it choose Opus-in-MP4 — an MP4 container Safari still
	// cannot decode. Verified against a real Chromium: isTypeSupported said true
	// for all three mp4 variants. So the AAC codec must be named explicitly.
	it('names the AAC codec explicitly, so Chrome cannot pick Opus-in-MP4', () => {
		const chromeLike = supporting('audio/mp4', 'audio/webm');
		expect(pickRecordingMimeType(chromeLike)).toBe('audio/mp4;codecs=mp4a.40.2');
		// And the bare form must never be preferred over the qualified one.
		expect(APPLE_PLAYABLE.indexOf('audio/mp4;codecs=mp4a.40.2')).toBeLessThan(APPLE_PLAYABLE.indexOf('audio/mp4'));
	});

	it('Opus in an MP4 container is NOT treated as Apple-playable', () => {
		expect(isApplePlayable('audio/mp4;codecs=opus')).toBe(false);
		expect(isApplePlayable('audio/mp4;codecs=mp4a.40.2')).toBe(true);
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
