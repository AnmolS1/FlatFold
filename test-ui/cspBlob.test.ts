// `fetch()` on a blob: URL is governed by connect-src — NOT by media-src or
// img-src. Both of those already allowed blob:, so images and <audio> playback
// worked and the gap looked like nothing was wrong. But the voice-note waveform
// decode does `fetch(objectUrl)` then `decodeAudioData`, and it failed instantly
// with "Load failed" on every note, on every platform, for as long as this CSP
// has existed. A bare catch turned that into flat bars instead of an error.
//
// Pinned here because it is invisible: nothing fails loudly, the waveform just
// silently never appears.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Match the DIRECTIVE, not prose: the native CSP file has a comment mentioning
// connect-src above the real one, and a loose regex finds the comment first.
const connectSrc = (csp: string) => /connect-src 'self'([^;"`]*)/.exec(csp)?.[1] ?? '';

describe('CSP allows fetching our own blob: URLs', () => {
	it('the native meta CSP permits blob: in connect-src', () => {
		const src = readFileSync(resolve(process.cwd(), 'scripts/inject-native-csp.mjs'), 'utf8');
		expect(connectSrc(src)).toContain('blob:');
	});

	it('the web _headers CSP permits blob: in connect-src', () => {
		const src = readFileSync(resolve(process.cwd(), 'public/_headers'), 'utf8');
		expect(connectSrc(src)).toContain('blob:');
	});

	// The reason this was hard to spot: the other two directives already had it.
	it('media-src and img-src still allow blob:, so playback and images are unaffected', () => {
		for (const f of ['scripts/inject-native-csp.mjs', 'public/_headers']) {
			const src = readFileSync(resolve(process.cwd(), f), 'utf8');
			expect(/media-src [^;"`]*blob:/.test(src)).toBe(true);
			expect(/img-src [^;"`]*blob:/.test(src)).toBe(true);
		}
	});
});
