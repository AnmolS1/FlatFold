// Voice notes STILL failed after the shared-AudioContext fix (3 of 7 in a
// conversation), because sharing the context only removed one of three eager
// per-note resources. The other two:
//
//   1. every VoiceNote rendered <audio src={blob}> on mount, playing or not, so
//      WebKit held a media decoder per note — including notes nobody touched;
//   2. every note fetched + decodeAudioData'd on mount to draw its waveform, so
//      N notes decoded at once on the one shared context.
//
// Fix, per Anmol's suggestion: take the audio resource only when the user
// actually hits play, and cap how many waveform decodes run at once.
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

describe('VoiceNote takes the audio resource lazily', () => {
	it('does not hand the <audio> element a src until the user plays', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const src = readFileSync(resolve(process.cwd(), 'src/components/chat/VoiceNote.tsx'), 'utf8');

		// preload="none" is the instruction to WebKit not to open a decoder.
		// Both players carry it: the hidden one we drive, and the native
		// `controls` fallback (which must keep a src, since the user drives it
		// directly and there is no gesture of ours to defer the assignment to).
		expect(src.match(/preload="none"/g) ?? []).toHaveLength(2);
		// The player WE drive must take its source only inside the play gesture.
		expect(src).toContain('el.src = url');
		// Waveform decoding must go through the concurrency cap.
		expect(src).toContain('decodeAudioLimited');
	});
});
