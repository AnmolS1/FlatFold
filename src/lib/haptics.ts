// A single, feature-detected haptic tick. Used on send, long-press, and verify
// — deliberately NOT on message receive (unsolicited buzzing is hostile, and a
// buzz on inbound could leak "a message arrived" to someone watching the phone).
//
// `navigator.vibrate` is unsupported on iOS Safari and desktop; the guard makes
// this a safe no-op there rather than a thrown TypeError.
export function haptic(durationMs = 10): void {
	try {
		if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
			navigator.vibrate(durationMs);
		}
	} catch {
		// Some embedded webviews expose `vibrate` but throw on call — ignore.
	}
}
