// `a.paused` is TRUE while a play() is still pending. Testing it alone meant a
// second tap during the start-up window called play() AGAIN instead of pausing,
// so tapping pause right after play did nothing.
//
// The AbortError seen on device came from exactly that sequence and is BENIGN —
// pausing aborts a play() that has not started. Treating it as a failure is what
// pointed this investigation at a bug that was not there.
import { describe, expect, it, vi, beforeEach } from 'vitest';

beforeEach(() => vi.resetModules());

function stubAudio() {
	const calls = { play: 0, pause: 0 };
	let resolvePlay: (() => void) | undefined;
	class FakeAudio {
		paused = true;
		src = '';
		currentTime = 0;
		duration = NaN;
		ended = false;
		error: unknown = undefined;
		addEventListener() {}
		removeAttribute() {}
		load() {}
		pause() { calls.pause++; this.paused = true; }
		play() {
			calls.play++;
			return new Promise<void>((res) => { resolvePlay = () => { this.paused = false; res(); }; });
		}
	}
	vi.stubGlobal('Audio', FakeAudio);
	return { calls, settle: () => resolvePlay?.() };
}

describe('shared player re-entrancy', () => {
	it('a tap during the start-up window PAUSES instead of starting a second play', async () => {
		const { calls, settle } = stubAudio();
		const { toggleSharedPlayback } = await import('../src/lib/audioPlayer');

		const first = toggleSharedPlayback('blob:one'); // play, still pending
		await toggleSharedPlayback('blob:one'); // user taps pause before it starts
		settle();
		await first;

		expect(calls.play).toBe(1); // NOT two
		expect(calls.pause).toBe(1); // the user's pause was honoured
	});

	it('an AbortError from pausing a pending play is not surfaced as a failure', async () => {
		vi.stubGlobal('Audio', class {
			paused = true; src = ''; currentTime = 0; duration = NaN; ended = false; error = undefined;
			addEventListener() {} removeAttribute() {} load() {} pause() {}
			play() { return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
		});
		const { toggleSharedPlayback } = await import('../src/lib/audioPlayer');
		await expect(toggleSharedPlayback('blob:one')).resolves.toBeUndefined();
	});

	it('still toggles to pause once the note is actually playing', async () => {
		const { calls, settle } = stubAudio();
		const { toggleSharedPlayback } = await import('../src/lib/audioPlayer');
		const first = toggleSharedPlayback('blob:one');
		settle();
		await first;
		await toggleSharedPlayback('blob:one');
		expect(calls.pause).toBe(1);
	});

	it('switching to a different note is not blocked by the guard', async () => {
		const { calls, settle } = stubAudio();
		const { toggleSharedPlayback, sharedPlayerState } = await import('../src/lib/audioPlayer');
		const first = toggleSharedPlayback('blob:one');
		settle();
		await first;
		const second = toggleSharedPlayback('blob:two');
		settle();
		await second;
		expect(calls.play).toBe(2);
		expect(sharedPlayerState().url).toBe('blob:two');
	});
});
