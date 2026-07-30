// Which voice note is playing, and where every other one left off.
//
// The native player is a SINGLETON — one `AVAudioPlayer` in the plugin — while
// the UI renders one component per note. This module is the seam between them:
// it owns the transport, remembers each note's position so returning to it
// resumes, and wakes only the component whose note changed.
//
// PER-NOTE SUBSCRIPTION IS THE POINT, not a refinement. Progress arrives at
// ~10 Hz; a store-wide notification would re-render every note in a forty-note
// conversation ten times a second to move one cursor.
//
// The backend is injected so the logic is testable off-device
// (`voicePlayer.test.ts`). The singleton at the bottom binds the real plugin.
//
// Only the native (Mac Catalyst) path uses this. Web and iOS keep the `<audio>`
// element, which works there — see `nativePlaybackSupported`.

import { nativePlayer } from './nativeAudio';

/** What one note's UI needs to draw itself. */
export interface NotePlaybackState {
	playing: boolean;
	/** Seconds into the note: the live position while playing, the paused one otherwise. */
	currentTime: number;
	/** Authoritative duration once known natively; 0 before the note has ever played. */
	duration: number;
}

export interface PlayerBackend {
	/**
	 * Start or resume `noteId`.
	 *
	 * `bytes === null` means "resume the note you already have loaded". The
	 * plugin rejects that with code `NEED_DATA` when it cannot, so the common
	 * pause→resume never re-ships ~100 KB of base64 across the bridge and the
	 * uncommon case still works. Resolves with the note's duration in seconds.
	 */
	play(noteId: string, bytes: Uint8Array | null, positionSeconds: number): Promise<number>;
	pause(): Promise<number>;
	stop(): Promise<void>;
	on(
		event: 'audioProgress' | 'audioEnded' | 'audioInterrupted',
		cb: (data: { noteId: string; currentTime?: number; duration?: number }) => void
	): void;
}

const IDLE: NotePlaybackState = Object.freeze({ playing: false, currentTime: 0, duration: 0 });

export interface VoicePlayer {
	/** This note's state. The SAME object identity until this note changes. */
	getState(noteId: string): NotePlaybackState;
	/** Listen for changes to one note. Returns an unsubscribe. */
	subscribe(noteId: string, cb: () => void): () => void;
	/**
	 * Play if idle or paused, pause if playing. `load` supplies the decrypted
	 * bytes and is only called when they are actually needed, so a resume costs
	 * nothing. Rejects if playback could not start.
	 */
	toggle(noteId: string, load: () => Promise<Uint8Array>): Promise<void>;
}

export function createVoicePlayer(backend: PlayerBackend): VoicePlayer {
	const listeners = new Map<string, Set<() => void>>();
	// Cached snapshots. `getState` must return a stable reference between real
	// changes or `useSyncExternalStore` re-renders without end.
	const snapshots = new Map<string, NotePlaybackState>();
	const positions = new Map<string, number>();
	const durations = new Map<string, number>();

	let activeId: string | null = null;
	// The note the PLUGIN still holds a player for, which outlives pausing and is
	// what makes a data-less resume possible. Distinct from `activeId`, which is
	// only the note the transport is currently running.
	let loadedId: string | null = null;
	let playing = false;
	let currentTime = 0;

	function compute(noteId: string): NotePlaybackState {
		const duration = durations.get(noteId) ?? 0;
		if (noteId === activeId) return { playing, currentTime, duration };
		const at = positions.get(noteId) ?? 0;
		return at === 0 && duration === 0 ? IDLE : { playing: false, currentTime: at, duration };
	}

	function getState(noteId: string): NotePlaybackState {
		let s = snapshots.get(noteId);
		if (!s) {
			s = compute(noteId);
			snapshots.set(noteId, s);
		}
		return s;
	}

	function changed(noteId: string): void {
		snapshots.delete(noteId);
		for (const cb of listeners.get(noteId) ?? []) cb();
	}

	/** Bank the active note's position so returning to it resumes. */
	function park(): void {
		if (!activeId) return;
		const parked = activeId;
		positions.set(parked, currentTime);
		activeId = null;
		playing = false;
		changed(parked);
	}

	backend.on('audioProgress', (d) => {
		// A tick from a player that has already been replaced. Applying it would
		// drag the cursor of a note that is no longer playing.
		if (d.noteId !== activeId) return;
		currentTime = d.currentTime ?? currentTime;
		if (d.duration) durations.set(d.noteId, d.duration);
		changed(d.noteId);
	});

	backend.on('audioEnded', (d) => {
		// Rewind rather than parking at the end: the next tap on a finished note
		// means "play it again", not "resume at the last millisecond".
		positions.delete(d.noteId);
		if (d.noteId === loadedId) loadedId = null;
		if (d.noteId === activeId) {
			activeId = null;
			playing = false;
			currentTime = 0;
		}
		changed(d.noteId);
	});

	backend.on('audioInterrupted', (d) => {
		if (d.noteId !== activeId) return;
		currentTime = d.currentTime ?? currentTime;
		park();
	});

	async function toggle(noteId: string, load: () => Promise<Uint8Array>): Promise<void> {
		if (noteId === activeId && playing) {
			const at = await backend.pause();
			currentTime = at;
			park();
			return;
		}

		// Whatever was playing is about to be replaced natively; record where it
		// got to first, or its position is lost.
		if (activeId !== null && activeId !== noteId) park();

		const from = positions.get(noteId) ?? 0;
		// The note the plugin still holds can resume without the bytes; anything
		// else needs them. `NEED_DATA` covers the case where that guess is wrong
		// (the player was torn down while the UI still thought it was paused).
		const canResume = loadedId === noteId;
		let duration: number;
		try {
			duration = canResume
				? await backend.play(noteId, null, from).catch(async (err: unknown) => {
						if ((err as { code?: string })?.code !== 'NEED_DATA') throw err;
						return backend.play(noteId, await load(), from);
					})
				: await backend.play(noteId, await load(), from);
		} catch (err) {
			// Leave the note visibly not-playing; the component surfaces the reason.
			activeId = null;
			loadedId = null;
			playing = false;
			changed(noteId);
			throw err;
		}

		loadedId = noteId;
		durations.set(noteId, duration);
		positions.delete(noteId);
		activeId = noteId;
		playing = true;
		currentTime = from;
		changed(noteId);
	}

	function subscribe(noteId: string, cb: () => void): () => void {
		const set = listeners.get(noteId) ?? new Set();
		set.add(cb);
		listeners.set(noteId, set);
		return () => {
			set.delete(cb);
			if (set.size === 0) listeners.delete(noteId);
		};
	}

	return { getState, subscribe, toggle };
}

export const voicePlayer = createVoicePlayer(nativePlayer);
