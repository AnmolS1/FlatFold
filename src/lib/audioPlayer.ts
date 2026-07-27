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
// The note whose play() is currently in flight, if any. See toggleSharedPlayback.
let starting: string | null = null;
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

	// ATTACH IT. This is the whole fix.
	//
	// WebKit does not load a DETACHED media element: `new Audio()` on its own,
	// never added to the document, produced no `loadedmetadata`, no `error`, and a
	// play() that neither resolved nor rejected. Silence, with nothing to debug.
	//
	// Every per-note <audio> before this was real JSX and therefore in the DOM,
	// which is why playback worked before the shared player and stopped the moment
	// the element became detached.
	//
	// `playsinline` because WKWebView otherwise wants to take audio full-screen,
	// and `display:none` because this element is driven entirely by our own UI.
	el.setAttribute('playsinline', '');
	el.preload = 'auto';
	el.style.display = 'none';
	if (typeof document !== 'undefined' && document.body) {
		document.body.appendChild(el);
	}

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
		// `a.paused` is TRUE while a play() is still pending, so testing it alone
		// made a second tap call play() AGAIN instead of pausing — tapping pause
		// during the start-up window did nothing. `starting` is what distinguishes
		// "not playing" from "about to play".
		// A tap arriving while play() is still pending is a DUPLICATE, not a pause:
		// one tap logged twice on device. Ignore it. Once the element is genuinely
		// playing, `starting` is null and the pause below works normally — which is
		// the case Anmol hit when pausing shortly after play.
		if (starting === url) return;
		if (!a.paused) {
			a.pause();
		} else {
			starting = url;
			try {
				await a.play();
			} finally {
				starting = null;
			}
		}
		notify();
		return;
	}
	currentUrl = url;
	a.src = url;
	notify();
	starting = url;
	try {
		await a.play();
	} catch (err) {
		// AbortError is EXPECTED and benign: pausing (or loading another note)
		// aborts a play() that has not started yet, which is exactly what a user
		// tapping play-then-pause produces. Reporting it as a failure sent this
		// investigation after a bug that was not there.
		const name = err instanceof Error ? err.name : '';
		if (name === 'AbortError') return;
		// Anything else is the browser genuinely refusing, and that signal was
		// being swallowed by the caller's `void` — which is why playback failures
		// produced no message at all.
		nativeLog(`play() rejected: ${err instanceof Error ? `${name}: ${err.message}` : String(err)}`);
		throw err;
	} finally {
		starting = null;
	}
}

/** Release the element if the note holding it is going away. */
export function releaseSharedPlayback(url: string): void {
	if (currentUrl !== url || !el) return;
	el.pause();
	el.removeAttribute('src');
	el.load();
	currentUrl = null;
	starting = null;
	notify();
}
