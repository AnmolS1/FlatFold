// Voice-note recording through the native plugin, for the one platform where
// the WebView cannot do it.
//
// On a Mac — BOTH "Designed for iPad" and Mac Catalyst — `navigator.mediaDevices`
// is simply absent. That was measured rather than assumed on each: the web layer
// reported `secure: true` with `mediaDevices: undefined`, so it is neither a
// permission problem nor a secure-context problem, and no amount of JS reaches
// the microphone. The Mac's microphone works; only the WebView's route to it is
// missing. So on those platforms we record in Swift (ios/App/App/
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
 * The PLUGIN decides, not the web layer — only native code can tell the two Mac
 * shells apart, and the answer must cover both. It reads `isMacCatalystApp ||
 * isiOSAppOnMac`; reading `isiOSAppOnMac` alone was a bug, because that flag is
 * false under Mac Catalyst, so the plugin reported "unsupported" on the very
 * platform it exists for and recording fell through to the absent
 * `getUserMedia`. Any failure means "no", so a missing or broken plugin degrades
 * to the browser path rather than breaking recording everywhere.
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

// --- Native PLAYBACK (Mac Catalyst only) -----------------------------------
//
// On Mac Catalyst, WKWebView grants media loaders in a window tied to page
// load, capped at ~30, and never reclaims them within that page. So the tail of
// a long conversation never plays and a newly arrived note never plays at all
// until relaunch. No arrangement of <audio> elements fixes that, because the
// web view is the constraint — see docs/redesign/MAC_AUDIO_FINDINGS.md.
//
// Verified 2026-07-28 on a real iPhone that iOS is UNAFFECTED, so this is
// scoped to Catalyst and iOS/web keep the <audio> path untouched.
//
// The bytes are base64'd across the bridge deliberately: a voice note is small
// (~75 KB, so ~100 KB encoded) and it means the plaintext of an E2EE message is
// never written to disk. The recorder's 104 KB payload once wedged the
// WebContent process, but that was the RESULT direction with the payload
// embedded as JS source; an argument in a plugin CALL is not the same path.

export interface PlaybackState {
	noteId: string;
	playing: boolean;
	currentTime: number;
	duration: number;
}

interface PlaybackPlugin {
	playNote?: (o: { noteId: string; dataBase64?: string; positionSeconds?: number }) => Promise<{ duration?: number }>;
	pauseNote?: () => Promise<{ currentTime?: number }>;
	seekNote?: (o: { seconds: number }) => Promise<{ currentTime?: number }>;
	stopNote?: () => Promise<void>;
	getPlaybackState?: () => Promise<PlaybackState>;
	addListener?: (event: string, cb: (data: unknown) => void) => void;
}

function playback(): PlaybackPlugin | null {
	return (capacitor()?.Plugins?.FlatFoldAudio as PlaybackPlugin | undefined) ?? null;
}

/**
 * Whether playback should go through Swift on this platform.
 *
 * SYNCHRONOUS, DELIBERATELY, AND NOT THE RECORDING SIGNAL. Recording is decided
 * on a user gesture and can afford the async round-trip to the plugin. Playback
 * is decided at RENDER: if this resolved a tick late, every note would mount an
 * `<audio src>` first and spend the very loader grant this exists to avoid.
 * `MainViewController` injects the flag at document start, so it is set before
 * React's first render. Two mechanisms because they answer at two different
 * moments — do not re-alias them.
 *
 * CATALYST ONLY. The ~30-loader cap was measured there; the "Designed for iPad"
 * shell was never tested for it, and Catalyst is the shell this branch migrates
 * to. Anything that is not Catalyst keeps the `<audio>` path, which is verified
 * working on a real iPhone.
 */
export function nativePlaybackSupported(): boolean {
	return (globalThis as unknown as { __flatfoldNativeAudio?: boolean }).__flatfoldNativeAudio === true;
}

/** Base64 for the bridge. Chunked — a naive spread on ~75 KB blows the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

export const nativePlayer = {
	/**
	 * Start `noteId`, or resume it when `bytes` is null.
	 *
	 * The null case sends no payload at all: the plugin still holds the player,
	 * so pause→resume costs a bare bridge call instead of ~100 KB of base64. It
	 * rejects with code `NEED_DATA` when it cannot honour that, which the caller
	 * recovers from by supplying the bytes.
	 */
	async play(noteId: string, bytes: Uint8Array | null, positionSeconds = 0): Promise<number> {
		const p = playback();
		if (!p?.playNote) throw new Error('Native playback is unavailable in this build.');
		const res = await p.playNote({
			noteId,
			...(bytes ? { dataBase64: bytesToBase64(bytes) } : {}),
			positionSeconds,
		});
		return res.duration ?? 0;
	},
	async pause(): Promise<number> {
		return (await playback()?.pauseNote?.())?.currentTime ?? 0;
	},
	async seek(seconds: number): Promise<void> {
		await playback()?.seekNote?.({ seconds });
	},
	async stop(): Promise<void> {
		await playback()?.stopNote?.();
	},
	async state(): Promise<PlaybackState | null> {
		return (await playback()?.getPlaybackState?.()) ?? null;
	},
	/** Subscribe to native transport events. Returns nothing; listeners live for the app's lifetime. */
	on(event: 'audioProgress' | 'audioEnded' | 'audioInterrupted', cb: (data: { noteId: string; currentTime?: number; duration?: number }) => void): void {
		playback()?.addListener?.(event, (d) => cb(d as { noteId: string; currentTime?: number; duration?: number }));
	},
};
