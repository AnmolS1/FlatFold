// One AudioContext for the whole app.
//
// This exists because VoiceNote used to build `new AudioContext()` per note, on
// mount, purely to decode a waveform. WebKit caps the number of concurrent
// AudioContexts at a small number, and the close was fire-and-forget
// (`void ctx?.close()`), so in a conversation with several voice notes they
// accumulated until construction started throwing.
//
// The symptom was nasty precisely because it did not look like a leak: notes
// failed at RANDOM (it depended on how many happened to be mounted) and came
// back after an app RESTART (which reset the count). And the failure surfaced
// through the native <audio> fallback as MEDIA_ERR_SRC_NOT_SUPPORTED, which the
// old code reported as "this device cannot decode the format
// (audio/mp4;codecs=mp4a.40.2)" — blaming the one format we picked BECAUSE Apple
// decodes it, and which other notes in the same list were playing fine.
//
// A shared context is also just correct: decoding does not need a context per
// caller, and `decodeAudioData` works on a suspended context, so this never
// needs resuming and never needs a user gesture.
//
// Deliberately never closed. It is one object for the process lifetime; closing
// it would break every VoiceNote still on screen.

let shared: AudioContext | null = null;
let unavailable = false;

/**
 * How many waveform decodes may run at once.
 *
 * Sharing the context was necessary but not sufficient: a conversation with
 * several voice notes still failed (3 of 7), because every note also fetched and
 * decoded on mount. `decodeAudioData` allocates a full PCM buffer per note —
 * roughly 5 MB for 30 seconds of mono 44.1 kHz — so N notes decoding together is
 * both a memory spike and a pile of simultaneous decoder work.
 *
 * Two is enough to keep waveforms appearing promptly while bounding the peak.
 */
export const DECODE_CONCURRENCY = 2;

/**
 * How long to wait for one decode before giving up on it.
 *
 * Generous — a long note on a slow machine is legitimately slow — but finite,
 * because an unbounded wait combined with the cap above turns one stuck decode
 * into every subsequent note being stuck. Timing out degrades that note to flat
 * bars and the native player, which is a far better outcome than a frozen list.
 */
export const DECODE_TIMEOUT_MS = 8000;

let active = 0;
const waiting: Array<() => void> = [];

// Decode outcomes, for the DEBUG census below. Counters only — no payloads.
const tally = { ok: 0, timedOut: 0, failed: 0 };

/**
 * A snapshot of this module's resource state.
 *
 * It exists because the two audio pools — Web Audio decodes here, and the
 * WebView's <audio> element pool — BOTH exhaust into
 * `MEDIA_ERR_SRC_NOT_SUPPORTED` (code 4). The user-facing text is identical
 * either way, so the symptom cannot tell them apart, and three separate attempts
 * at this bug were aimed at a pool that was never measured. Read alongside a DOM
 * census of <audio> elements, this says which one is actually short.
 */
export function audioPoolStats() {
	return { active, waiting: waiting.length, unavailable, hasContext: shared !== null, ...tally };
}

// Exposed for the native probe (MainViewController), on debug builds only.
if (typeof window !== 'undefined' && (window as unknown as { __flatfoldDebug?: boolean }).__flatfoldDebug) {
	(window as unknown as { __flatfoldAudioStats?: unknown }).__flatfoldAudioStats = audioPoolStats;
}

/**
 * Run an audio decode under a global concurrency cap.
 *
 * The slot is released in `finally`, so a decode that throws — which is exactly
 * what happens when resources are already exhausted — cannot wedge the queue for
 * every note after it.
 */
export async function decodeAudioLimited<T>(task: () => Promise<T>): Promise<T> {
	if (active >= DECODE_CONCURRENCY) {
		await new Promise<void>((resolve) => waiting.push(resolve));
	}
	active++;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		// `decodeAudioData` is not guaranteed to settle. A WebKit AudioContext
		// under resource pressure can leave it pending forever, and combined with
		// a concurrency cap that is WORSE than having no cap at all: two hung
		// decodes hold both slots and every note behind them waits on a promise
		// that will never resolve. The symptom is "all voice notes are broken",
		// which is indistinguishable from a codec or download failure.
		const out = await Promise.race([
			task(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('audio decode timed out')), DECODE_TIMEOUT_MS);
			}),
		]);
		tally.ok++;
		return out;
	} catch (err) {
		// Distinguished, not lumped: a timeout means a decode is still running and
		// holding real resources after we stopped waiting for it, which is a very
		// different problem from one that failed and released.
		if (err instanceof Error && err.message === 'audio decode timed out') tally.timedOut++;
		else tally.failed++;
		throw err;
	} finally {
		if (timer) clearTimeout(timer);
		active--;
		waiting.shift()?.();
	}
}

/**
 * The process-wide AudioContext, or null if this platform has none.
 *
 * Returns null rather than throwing so callers can degrade to the native
 * <audio> element, which is the correct fallback.
 */
export function getSharedAudioContext(): AudioContext | null {
	if (shared) return shared;
	if (unavailable) return null;

	const Ctor =
		typeof AudioContext !== 'undefined'
			? AudioContext
			: (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

	if (!Ctor) {
		unavailable = true;
		return null;
	}
	try {
		shared = new Ctor();
		return shared;
	} catch {
		// Construction can still fail (a platform cap already reached elsewhere).
		// Remember it so we do not retry on every note render.
		unavailable = true;
		return null;
	}
}
