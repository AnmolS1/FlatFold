// The voice-note player store, which owns "which note is playing and where".
//
// It exists because native playback is a SINGLETON — one `AVAudioPlayer` in the
// plugin — while the UI is one component per note. Something has to hold the
// mapping from that single transport to forty components, remember where each
// paused note left off, and wake only the component that changed. That is the
// whole job, and it is testable without a device, which is why it is a separate
// module from `VoiceNote.tsx`.
//
// The backend is injected so these tests never touch Capacitor. The singleton at
// the bottom of the module binds the real one.
import { describe, expect, it, vi } from 'vitest';
import { createVoicePlayer, type PlayerBackend } from './voicePlayer';

type Listener = (data: { noteId: string; currentTime?: number; duration?: number }) => void;

/** A stand-in for the Swift player: records calls, and can fire its events. */
function fakeBackend() {
	const listeners = new Map<string, Listener[]>();
	const calls: Array<{ method: string; noteId?: string; bytes: number | null; position?: number }> = [];
	let duration = 10;
	let resumable = false; // whether a paused player is still loaded natively

	const backend: PlayerBackend & {
		calls: typeof calls;
		fire: (event: string, data: Parameters<Listener>[0]) => void;
		setDuration: (d: number) => void;
		setResumable: (r: boolean) => void;
	} = {
		calls,
		fire(event, data) {
			for (const cb of listeners.get(event) ?? []) cb(data);
		},
		setDuration(d) {
			duration = d;
		},
		setResumable(r) {
			resumable = r;
		},
		async play(noteId, bytes, position) {
			calls.push({ method: 'play', noteId, bytes: bytes ? bytes.length : null, position });
			// The real plugin rejects a data-less call it cannot satisfy, so the
			// store must be able to recover by sending the bytes.
			if (bytes === null && !resumable) {
				const err = new Error('no player to resume') as Error & { code: string };
				err.code = 'NEED_DATA';
				throw err;
			}
			resumable = true;
			return duration;
		},
		async pause() {
			calls.push({ method: 'pause', bytes: null });
			return 3.5;
		},
		async stop() {
			calls.push({ method: 'stop', bytes: null });
			resumable = false;
		},
		on(event, cb) {
			listeners.set(event, [...(listeners.get(event) ?? []), cb as Listener]);
		},
	};
	return backend;
}

const bytes = () => new Uint8Array([1, 2, 3, 4]);
const load = () => Promise.resolve(bytes());

describe('voicePlayer', () => {
	it('starts a note from the beginning and reports it playing', async () => {
		const backend = fakeBackend();
		const player = createVoicePlayer(backend);

		await player.toggle('A', load);

		expect(backend.calls).toContainEqual({ method: 'play', noteId: 'A', bytes: 4, position: 0 });
		expect(player.getState('A')).toEqual({ playing: true, currentTime: 0, duration: 10 });
	});

	it('leaves other notes idle while one plays', async () => {
		const player = createVoicePlayer(fakeBackend());
		await player.toggle('A', load);
		expect(player.getState('B')).toEqual({ playing: false, currentTime: 0, duration: 0 });
	});

	it('pauses the active note and keeps its position', async () => {
		const backend = fakeBackend();
		const player = createVoicePlayer(backend);

		await player.toggle('A', load);
		await player.toggle('A', load);

		expect(backend.calls.map((c) => c.method)).toEqual(['play', 'pause']);
		expect(player.getState('A')).toEqual({ playing: false, currentTime: 3.5, duration: 10 });
	});

	// THE case that motivates the position map: a chat is a list, and people
	// stop one note to hear another and come back.
	it('resumes a note where it was paused after another note played', async () => {
		const backend = fakeBackend();
		const player = createVoicePlayer(backend);

		await player.toggle('A', load); // play A
		await player.toggle('A', load); // pause A at 3.5
		await player.toggle('B', load); // play B — A is no longer loaded natively
		await player.toggle('A', load); // back to A

		const last = backend.calls[backend.calls.length - 1];
		expect(last).toEqual({ method: 'play', noteId: 'A', bytes: 4, position: 3.5 });
		expect(player.getState('A').playing).toBe(true);
		expect(player.getState('B').playing).toBe(false);
	});

	// Switching without pausing first must not lose the position either — the
	// native player is a singleton, so starting B silently ends A.
	it('remembers where the previous note was when another note takes over', async () => {
		const backend = fakeBackend();
		const player = createVoicePlayer(backend);

		await player.toggle('A', load);
		backend.fire('audioProgress', { noteId: 'A', currentTime: 6, duration: 10 });
		await player.toggle('B', load);

		expect(player.getState('A')).toEqual({ playing: false, currentTime: 6, duration: 10 });
	});

	it('resumes without re-sending the bytes when the note is still loaded natively', async () => {
		const backend = fakeBackend();
		const player = createVoicePlayer(backend);

		await player.toggle('A', load); // play
		await player.toggle('A', load); // pause — still the native player's note
		backend.calls.length = 0;
		await player.toggle('A', load); // resume

		expect(backend.calls).toEqual([{ method: 'play', noteId: 'A', bytes: null, position: 3.5 }]);
	});

	it('falls back to sending the bytes when the native player cannot resume', async () => {
		const backend = fakeBackend();
		const player = createVoicePlayer(backend);

		await player.toggle('A', load);
		await player.toggle('A', load); // paused
		backend.setResumable(false); // e.g. the app was backgrounded and torn down
		backend.calls.length = 0;
		await player.toggle('A', load);

		expect(backend.calls.map((c) => c.bytes)).toEqual([null, 4]);
		expect(player.getState('A').playing).toBe(true);
	});

	it('rewinds a finished note rather than leaving it at the end', async () => {
		const backend = fakeBackend();
		const player = createVoicePlayer(backend);

		await player.toggle('A', load);
		backend.fire('audioProgress', { noteId: 'A', currentTime: 9.9, duration: 10 });
		backend.fire('audioEnded', { noteId: 'A' });

		expect(player.getState('A')).toEqual({ playing: false, currentTime: 0, duration: 10 });

		backend.calls.length = 0;
		await player.toggle('A', load);
		expect(backend.calls[0].position).toBe(0);
	});

	it('pauses in place when the system interrupts playback', async () => {
		const backend = fakeBackend();
		const player = createVoicePlayer(backend);

		await player.toggle('A', load);
		backend.fire('audioInterrupted', { noteId: 'A', currentTime: 4.25 });

		expect(player.getState('A')).toEqual({ playing: false, currentTime: 4.25, duration: 10 });
	});

	// Progress arrives ~10 times a second. Waking all forty components for it
	// would make a playing note cost forty renders per tick.
	it('notifies only the subscriber for the note that changed', async () => {
		const backend = fakeBackend();
		const player = createVoicePlayer(backend);
		const onA = vi.fn();
		const onB = vi.fn();
		player.subscribe('A', onA);
		player.subscribe('B', onB);

		await player.toggle('A', load);
		onA.mockClear();
		onB.mockClear();
		backend.fire('audioProgress', { noteId: 'A', currentTime: 1, duration: 10 });

		expect(onA).toHaveBeenCalled();
		expect(onB).not.toHaveBeenCalled();
	});

	it('stops notifying after unsubscribe', async () => {
		const backend = fakeBackend();
		const player = createVoicePlayer(backend);
		const onA = vi.fn();
		const off = player.subscribe('A', onA);
		off();

		await player.toggle('A', load);

		expect(onA).not.toHaveBeenCalled();
	});

	// useSyncExternalStore re-renders forever if getSnapshot returns a new object
	// every call, so identity has to be stable until something actually changes.
	it('returns a stable state object until that note changes', async () => {
		const backend = fakeBackend();
		const player = createVoicePlayer(backend);

		const first = player.getState('A');
		expect(player.getState('A')).toBe(first);

		await player.toggle('A', load);
		const playingState = player.getState('A');
		expect(playingState).not.toBe(first);
		expect(player.getState('A')).toBe(playingState);
	});

	it('ignores progress for a note that is no longer the active one', async () => {
		const backend = fakeBackend();
		const player = createVoicePlayer(backend);

		await player.toggle('A', load);
		await player.toggle('B', load);
		// A late tick from the player that was just torn down.
		backend.fire('audioProgress', { noteId: 'A', currentTime: 99, duration: 10 });

		expect(player.getState('A').playing).toBe(false);
		expect(player.getState('B').playing).toBe(true);
	});

	it('surfaces a failure to start rather than claiming the note is playing', async () => {
		const backend = fakeBackend();
		const player = createVoicePlayer(backend);
		backend.play = async () => {
			throw new Error('the audio system refused to start playback');
		};

		await expect(player.toggle('A', load)).rejects.toThrow(/refused/);
		expect(player.getState('A').playing).toBe(false);
	});
});
