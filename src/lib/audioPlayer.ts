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
	return el;
}

export interface SharedPlayerState {
	url: string | null;
	playing: boolean;
	currentTime: number;
	duration: number;
	errorCode: number | undefined;
}

export function sharedPlayerState(): SharedPlayerState {
	return {
		url: currentUrl,
		playing: !!el && !el.paused && !el.ended,
		currentTime: el?.currentTime ?? 0,
		duration: el && isFinite(el.duration) ? el.duration : 0,
		errorCode: el?.error?.code,
	};
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
	await a.play();
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
