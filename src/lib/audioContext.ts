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
