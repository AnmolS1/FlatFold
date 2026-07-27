import { nativeLog } from './nativeLog';

// ONE <audio> element for the whole app.
//
// Every VoiceNote used to own its own media element. WebKit caps concurrent
// media resources, so a conversation with several notes exhausted the pool and
// notes failed with MEDIA_ERR_SRC_NOT_SUPPORTED — which reads as a codec error
// and is not one. Capping decodes and preloading metadata only both helped and
// neither was sufficient, because the cost scaled with how many notes were
// RENDERED rather than how many were played.
//
// Only one voice note can play at a time, so N elements were never needed. This
// is one element, reused, and the per-note cost drops to zero.
//
// Deliberately not React state: the element must outlive any component, and two
// notes must never be able to hold two elements even for a render.

let el: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
const listeners = new Set<() => void>();

function notify() {
	// Only wake subscribers when the snapshot actually moved. Notifying on an
	// unchanged snapshot is harmless for correctness but wasteful, and during
	// timeupdate it fires several times a second per note.
	if (!recompute()) return;
	for (const l of listeners) l();
}

function ensure(): HTMLAudioElement | null {
	if (el) return el;
	if (typeof Audio === 'undefined') return null;
	el = new Audio();
	// `preload` is irrelevant now — there is only one element and it only ever
	// holds the note being played.
	for (const ev of ['play', 'pause', 'ended', 'timeupdate', 'loadedmetadata', 'error']) {
		el.addEventListener(ev, notify);
	}
	// Playback failures were invisible: the element's `error` event only updates
	// a snapshot field, and the play() rejection below was discarded by the
	// caller's `void`. Both are now reported.
	el.addEventListener('error', () => {
		const e = el?.error;
		nativeLog(`audio element error code=${e?.code ?? '?'} message=${e?.message ?? ''}`);
	});
	el.addEventListener('loadedmetadata', () => {
		nativeLog(`audio loadedmetadata duration=${el?.duration ?? '?'}`);
	});
	return el;
}

export interface SharedPlayerState {
	url: string | null;
	playing: boolean;
	currentTime: number;
	duration: number;
	errorCode: number | undefined;
}

// The snapshot MUST be cached.
//
// `useSyncExternalStore` compares snapshots with Object.is to decide whether the
// store changed. A getSnapshot that builds a fresh object each call therefore
// reports "changed" on every single render — React re-renders forever, and the
// whole chat lands in the ErrorBoundary. That shipped, and it took the app out
// entirely: "Something broke", no chat, and a reload could not help because the
// loop restarts on the next render.
//
// So: recompute only when something really moved, and hand out the same object
// until then.
let snapshot: SharedPlayerState = {
	url: null,
	playing: false,
	currentTime: 0,
	duration: 0,
	errorCode: undefined,
};

function recompute(): boolean {
	const next: SharedPlayerState = {
		url: currentUrl,
		playing: !!el && !el.paused && !el.ended,
		currentTime: el?.currentTime ?? 0,
		duration: el && isFinite(el.duration) ? el.duration : 0,
		errorCode: el?.error?.code,
	};
	if (
		next.url === snapshot.url &&
		next.playing === snapshot.playing &&
		next.currentTime === snapshot.currentTime &&
		next.duration === snapshot.duration &&
		next.errorCode === snapshot.errorCode
	) {
		return false;
	}
	snapshot = next;
	return true;
}

export function sharedPlayerState(): SharedPlayerState {
	return snapshot;
}

export function subscribeSharedPlayer(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

/**
 * Play `url`, or toggle it if it is already the loaded note.
 *
 * Switching notes reassigns the single element's source, which implicitly stops
 * whatever was playing — the behaviour you want, and previously something each
 * note had to be told to do.
 */
export async function toggleSharedPlayback(url: string): Promise<void> {
	const a = ensure();
	if (!a) return;
	if (currentUrl === url) {
		if (a.paused) await a.play();
		else a.pause();
		notify();
		return;
	}
	currentUrl = url;
	a.src = url;
	notify();
	try {
		await a.play();
	} catch (err) {
		// A rejected play() was silently swallowed by the caller. That is the one
		// signal that says "the browser refused to play this", and losing it is
		// why playback failures produced no message at all.
		nativeLog(`play() rejected: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
		throw err;
	}
}

/** Release the element if the note holding it is going away. */
export function releaseSharedPlayback(url: string): void {
	if (currentUrl !== url || !el) return;
	el.pause();
	el.removeAttribute('src');
	el.load();
	currentUrl = null;
	notify();
}
