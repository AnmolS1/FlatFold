// Turning a getUserMedia rejection into something a person can act on.
//
// This exists because the microphone failure on Mac was undiagnosable for
// several rounds, and the cause was one line:
//
//     } catch { setError('Could not access the microphone.'); }
//
// A bare catch. getUserMedia rejects with a DOMException whose `.name` states
// the failure precisely, and it was being discarded — so "the mic doesn't work"
// was all anyone could report, and speculation about sandbox entitlements filled
// the gap. The name is the whole diagnosis, so it is always included in the
// message: a screenshot of the UI is then enough to tell permission from
// no-device from device-busy, with no rebuild.
//
// Same principle as the voice-note failure text: say WHY, and name the thing.

/**
 * A human-readable, actionable description of a getUserMedia failure.
 *
 * `onMac` picks where to send someone for the permission, because "Settings"
 * means two different apps on iOS and on an iPad app running on a Mac.
 */
export function describeMicrophoneError(err: unknown, onMac: boolean): string {
	// Read `.name` structurally rather than via `instanceof Error`.
	//
	// getUserMedia rejects with a DOMException, and DOMException does NOT reliably
	// inherit from Error — it does in current browsers, it does not in jsdom. An
	// `instanceof Error` guard therefore passes in the browser and silently
	// degrades to "UnknownError" under test, which is the worst way round: the
	// tests would go green while hiding the diagnosis in the only environment that
	// matters. Caught by the tests here.
	const name =
		typeof err === 'object' && err !== null && typeof (err as { name?: unknown }).name === 'string'
			? (err as { name: string }).name
			: 'UnknownError';

	// Where the microphone permission actually lives, per platform.
	const grantPath = onMac
		? 'System Settings → Privacy & Security → Microphone'
		: 'Settings → Privacy & Security → Microphone';

	switch (name) {
		case 'NotAllowedError':
		case 'PermissionDeniedError': // older spelling, still seen in the wild
			return `Microphone access was denied. Allow it in ${grantPath}, then try again. (${name})`;
		case 'NotFoundError':
		case 'DevicesNotFoundError':
			return `There is no microphone available on this device. (${name})`;
		case 'NotReadableError':
		case 'TrackStartError':
			return `The microphone is in use by another app, or the system would not start it. (${name})`;
		case 'SecurityError':
			return `The browser blocked microphone access on this page for security reasons. (${name})`;
		case 'OverconstrainedError':
			return `No microphone matched the requested settings. (${name})`;
		case 'AbortError':
			return `Starting the microphone was interrupted. Try again. (${name})`;
		default:
			return `Could not access the microphone. (${name})`;
	}
}
