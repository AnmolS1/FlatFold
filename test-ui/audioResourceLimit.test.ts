// Voice notes STILL failed after the shared-AudioContext fix (3 of 7 in a
// conversation), because sharing the context only removed one of three eager
// per-note resources. The other two:
//
//   1. every VoiceNote rendered <audio src={blob}> on mount, playing or not, so
//      WebKit held a media decoder per note — including notes nobody touched;
//   2. every note fetched + decodeAudioData'd on mount to draw its waveform, so
//      N notes decoded at once on the one shared context.
//
// The first attempt at the fix over-reached: it withheld the audio element's
// source until the first play. That regressed BOTH visible behaviours — with no
// source, onLoadedMetadata never fires so every note rendered 00:00, and
// assigning .src imperatively alongside a state update raced React's re-render
// of the same element so play() hung. Preloading is the supported lever; the
// source is not the problem. What survives: preload metadata only, cap the
// concurrent decodes, and bound each decode so one hang cannot wedge the rest.
import { describe, expect, it, vi, beforeEach } from 'vitest';

beforeEach(() => vi.resetModules());

describe('decodeAudioLimited', () => {
	it('never runs more than the cap concurrently, however many are queued', async () => {
		const { decodeAudioLimited, DECODE_CONCURRENCY } = await import('../src/lib/audioContext');
		let live = 0;
		let peak = 0;
		const release: Array<() => void> = [];

		const tasks = Array.from({ length: 8 }, () =>
			decodeAudioLimited(async () => {
				live++;
				peak = Math.max(peak, live);
				await new Promise<void>((res) => release.push(res));
				live--;
				return 'ok';
			})
		);

		// Let the scheduler start whatever it will start.
		await new Promise((r) => setTimeout(r, 0));
		expect(peak).toBeGreaterThan(0); // it must actually start work
		expect(peak).toBeLessThanOrEqual(DECODE_CONCURRENCY);

		// Drain: 8 tasks at a cap of 2 need several rounds, and each release lets
		// the next queued task in. Keep going until every one has been let go.
		for (let round = 0; round < 20 && release.length; round++) {
			while (release.length) release.shift()!();
			await new Promise((r) => setTimeout(r, 0));
		}
		await Promise.all(tasks);
		expect(peak).toBeLessThanOrEqual(DECODE_CONCURRENCY);
	});

	it('releases its slot when a task throws, so one failure cannot wedge the queue', async () => {
		const { decodeAudioLimited } = await import('../src/lib/audioContext');
		await expect(decodeAudioLimited(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
		// The queue must still be usable afterwards.
		await expect(decodeAudioLimited(async () => 'fine')).resolves.toBe('fine');
	});

	it('propagates results in order per caller', async () => {
		const { decodeAudioLimited } = await import('../src/lib/audioContext');
		const out = await Promise.all([1, 2, 3].map((n) => decodeAudioLimited(async () => n * 2)));
		expect(out).toEqual([2, 4, 6]);
	});
});

describe('VoiceNote owns no media element of its own', () => {
	it('plays through the shared element instead of rendering <audio>', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const src = readFileSync(resolve(process.cwd(), 'src/components/chat/VoiceNote.tsx'), 'utf8');

		// The exhaustion scaled with how many notes were RENDERED. One element
		// per note is the thing that must not come back.
		//
		// Matched as JSX (a tag followed by whitespace/newline then an attribute
		// or close) rather than the bare string: three times now, a comment
		// explaining the rule has matched the rule and failed its own test.
		expect(src).not.toMatch(/<audio[\s/>]/);
		expect(src).toContain('toggleSharedPlayback');
		// And it must hand the element back when it goes away.
		expect(src).toContain('releaseSharedPlayback');
		// Waveform decoding still goes through the concurrency cap.
		expect(src).toContain('decodeAudioLimited');
	});
});

describe('a hung decode cannot wedge every note behind it', () => {
	// decodeAudioData is not guaranteed to settle — a WebKit AudioContext under
	// resource pressure can leave it pending forever. With a concurrency cap that
	// is worse than no cap: two hung decodes hold both slots and every later note
	// waits on a promise that will never resolve, which looks exactly like "all
	// voice notes are broken".
	it('times out, releases its slot, and lets the next note through', async () => {
		const { decodeAudioLimited, DECODE_TIMEOUT_MS } = await import('../src/lib/audioContext');
		expect(DECODE_TIMEOUT_MS).toBeGreaterThan(0);

		const hung = Array.from({ length: 2 }, () =>
			decodeAudioLimited(() => new Promise(() => {})).catch((e) => (e as Error).message)
		);
		// A third note queued behind two hangs must still complete.
		const after = decodeAudioLimited(async () => 'made it');
		await expect(after).resolves.toBe('made it');
		for (const h of hung) expect(await h).toMatch(/timed out|timeout/i);
	}, 20000);
});
