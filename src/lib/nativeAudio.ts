// Voice-note recording through the native plugin, for the one platform where
// the WebView cannot do it.
//
// On "Designed for iPad" running on a Mac, `navigator.mediaDevices` is simply
// absent. That was measured rather than assumed: the web layer reported
// `secure: yes` with `mediaDevices: false`, so it is neither a permission
// problem nor a secure-context problem, and no amount of JS reaches the
// microphone. The Mac's microphone works; only the WebView's route to it is
// missing. So on that platform we record in Swift (ios/App/App/
// FlatFoldAudioPlugin.swift) and hand the bytes back here.
//
// Everywhere else — iPhone, iPad, every browser — `getUserMedia` works and stays
// the path. It needs no native surface and no extra permission plumbing, so this
// module deliberately reports unsupported there.

import { timed } from './nativeLog';

/** What the native recorder hands back, shaped like the browser path's output. */
export interface NativeRecording {
	bytes: Uint8Array;
	mimeType: string;
	durationMs: number;
}

interface AudioPlugin {
	isSupported?: () => Promise<{ supported?: boolean; mimeType?: string }>;
	requestPermission?: () => Promise<{ granted?: boolean }>;
	startRecording?: () => Promise<{ mimeType?: string }>;
	stopRecording?: () => Promise<{ path?: string; byteLength?: number; mimeType?: string; durationMs?: number }>;
	discardRecording?: (opts: { path: string }) => Promise<void>;
}

interface CapacitorGlobal {
	Plugins?: Record<string, unknown>;
	convertFileSrc?: (path: string) => string;
}

function capacitor(): CapacitorGlobal | undefined {
	return (globalThis as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

function plugin(): AudioPlugin | null {
	return (capacitor()?.Plugins?.FlatFoldAudio as AudioPlugin | undefined) ?? null;
}

/**
 * Read the finished recording through Capacitor's file scheme.
 *
 * NOT over the bridge. Capacitor delivers plugin results by evaluating
 * JavaScript with the payload embedded as SOURCE, and ~104 KB of base64 for a
 * four-second note wedged the WebContent process outright — the device log went
 * from a healthy native probe straight to
 * `WebProcessProxy::didBecomeUnresponsive`. The recording had been fine for
 * several rounds; the transport was the bug.
 *
 * `convertFileSrc` maps the path to a URL WKWebView's own handler serves, so the
 * bytes stream in and never become JS source.
 */
export async function readRecordingFile(path: string): Promise<Uint8Array> {
	const convert = capacitor()?.convertFileSrc;
	const src = convert ? convert(path) : path;
	const res = await fetch(src);

	// Deliberately NOT gated on `res.ok` / `res.status`.
	//
	// WKWebView's custom scheme handler can reply with a plain URLResponse rather
	// than an HTTPURLResponse, and JS then sees `status === 0` and `ok === false`
	// on a completely successful read. Checking the status rejected a response
	// whose body was perfectly fine — it shipped as "could not read the
	// recording (0)". The BODY is the evidence here; the status line is not.
	const buf = await res.arrayBuffer();
	if (buf.byteLength === 0) {
		throw new Error(`could not read the recording — it came back empty (status ${res.status})`);
	}
	return new Uint8Array(buf);
}

/** Decode the base64 the plugin sends across Capacitor's JSON bridge. */
export function base64ToBytes(b64: string): Uint8Array {
	if (!b64) return new Uint8Array(0);
	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/**
 * Whether to use the native recorder here.
 *
 * The PLUGIN decides, not the web layer — it answers from
 * `ProcessInfo.isiOSAppOnMac`, which is the authoritative signal. Any failure
 * means "no", so a missing or broken plugin degrades to the browser path rather
 * than breaking recording everywhere.
 */
export async function nativeRecordingSupported(): Promise<boolean> {
	try {
		const p = plugin();
		if (!p?.isSupported) return false;
		return (await p.isSupported()).supported === true;
	} catch {
		return false;
	}
}

/** Map a plugin rejection to something a person can act on. */
function describe(err: unknown, fallback: string): Error {
	const code = typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
	switch (code) {
		case 'PERMISSION_DENIED':
			return new Error('Microphone access was denied. Allow it in System Settings → Privacy & Security → Microphone, then try again.');
		case 'EMPTY':
			return new Error('That recording captured nothing — check the input device is not muted.');
		case 'NO_INPUT':
			// The audio queue failed to start, so the file has a header and no
			// samples. Better to say so than to send a note that plays as silence.
			return new Error('The microphone did not start. Check the input device in System Settings → Sound, then try again.');
		case 'NOT_RECORDING':
			return new Error('Recording had already stopped.');
		case 'UNPLAYABLE':
			// The plugin parsed the finished file and it is not playable. Failing
			// here beats encrypting and uploading something that shows a spinner
			// forever on every device that receives it.
			return new Error('The recording came out unplayable. Please try again.');
		case 'FINALIZE_FAILED':
			// The container index was never written, so the file would be
			// unplayable. Better to say so than to send something that shows a
			// spinner forever on every device that receives it.
			return new Error('The recording could not be finished. Please try again.');
		default:
			return new Error(fallback);
	}
}

export const recordNatively = {
	/**
	 * Begin recording. Rejects if permission is refused — the plugin asks every
	 * time rather than caching, because the answer can change in System Settings
	 * between launches.
	 */
	async start(): Promise<{ stop: () => Promise<NativeRecording> }> {
		const p = plugin();
		// Check each method at its point of use, not both up front: a permission
		// denial must surface as a permission message, never as "unavailable".
		if (!p?.startRecording) {
			throw new Error('Native recording is unavailable in this build.');
		}
		try {
			await p.startRecording();
		} catch (err) {
			throw describe(err, 'Could not start recording.');
		}

		return {
			async stop(): Promise<NativeRecording> {
				if (!p.stopRecording) throw new Error('Native recording is unavailable in this build.');
				let res;
				try {
					res = await p.stopRecording();
				} catch (err) {
					throw describe(err, 'Could not finish the recording.');
				}

				const path = res.path ?? '';
				if (!path) throw new Error('The recording could not be located.');
				try {
					const bytes = await timed('read file', () => readRecordingFile(path));
					// The plugin reports what it wrote. A short read means the file
					// was truncated or still being written, and sending it would
					// produce a note that plays as a fragment.
					if (typeof res.byteLength === 'number' && bytes.length !== res.byteLength) {
						throw new Error('The recording was incomplete. Please try again.');
					}
					return {
						bytes,
						// Pinned by the plugin to match APPLE_PLAYABLE[0]; the
						// fallback keeps the contract if the field ever goes missing.
						mimeType: res.mimeType ?? 'audio/mp4;codecs=mp4a.40.2',
						durationMs: res.durationMs ?? 0,
					};
				} finally {
					// Always: the file is plaintext audio of an E2E-encrypted
					// message and must not outlive the send, even on failure.
					await p.discardRecording?.({ path }).catch(() => {});
				}
			},
		};
	},
};
