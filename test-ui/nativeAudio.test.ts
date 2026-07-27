// Native voice-note recording, used ONLY where the WebView has no
// `navigator.mediaDevices` — measured on "Designed for iPad" on a Mac, where the
// web layer reported `secure: yes` with `mediaDevices: false`. The microphone
// hardware is fine there; only the WebView's route to it is missing.
//
// The failure paths are the point of these tests. A denied permission and an
// empty recording are both invisible in normal use and are exactly what an App
// Store reviewer or a first-run user hits.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { base64ToBytes, recordNatively, nativeRecordingSupported } from '../src/lib/nativeAudio';

type Handlers = Record<string, (...args: unknown[]) => unknown>;
const withPlugin = (h: Handlers) => {
	vi.stubGlobal('Capacitor', { Plugins: { FlatFoldAudio: h } });
};

beforeEach(() => vi.unstubAllGlobals());

describe('base64ToBytes', () => {
	it('round-trips bytes the plugin sends across the bridge', () => {
		// Capacitor's channel is JSON, so audio crosses as base64 and must arrive
		// byte-identical — a corrupted decode would produce an unplayable note
		// that looks exactly like a codec bug.
		const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
		const b64 = btoa(String.fromCharCode(...bytes));
		expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
	});

	it('returns an empty array for an empty string rather than throwing', () => {
		expect(base64ToBytes('').length).toBe(0);
	});
});

describe('nativeRecordingSupported', () => {
	it('is false when the plugin is absent (web, and any normal browser)', async () => {
		vi.stubGlobal('Capacitor', undefined);
		expect(await nativeRecordingSupported()).toBe(false);
	});

	it('is false on iPhone/iPad, where getUserMedia works and is the better path', async () => {
		withPlugin({ isSupported: async () => ({ supported: false }) });
		expect(await nativeRecordingSupported()).toBe(false);
	});

	it('is true only where the plugin says the WebView route is missing', async () => {
		withPlugin({ isSupported: async () => ({ supported: true }) });
		expect(await nativeRecordingSupported()).toBe(true);
	});

	it('is false — not a crash — when the plugin call itself rejects', async () => {
		withPlugin({ isSupported: async () => { throw new Error('boom'); } });
		expect(await nativeRecordingSupported()).toBe(false);
	});
});

describe('recordNatively', () => {
	it('reads bytes via the file scheme, not the bridge, and discards the file', async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const discarded: string[] = [];
		vi.stubGlobal('fetch', async () => ({ ok: true, arrayBuffer: async () => bytes.buffer }));
		vi.stubGlobal('Capacitor', {
			convertFileSrc: (p: string) => `capacitor://localhost/_capacitor_file_${p}`,
			Plugins: {
				FlatFoldAudio: {
					startRecording: async () => ({ mimeType: 'audio/mp4;codecs=mp4a.40.2' }),
					stopRecording: async () => ({
						path: '/tmp/flatfold-voice-x.m4a',
						byteLength: 3,
						mimeType: 'audio/mp4;codecs=mp4a.40.2',
						durationMs: 1500,
					}),
					discardRecording: async ({ path }: { path: string }) => { discarded.push(path); },
				},
			},
		});
		const session = await recordNatively.start();
		const result = await session.stop();
		expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
		expect(result.durationMs).toBe(1500);
		expect(result.mimeType).toBe('audio/mp4;codecs=mp4a.40.2');
		// Plaintext audio of an E2E-encrypted message must not outlive the send.
		expect(discarded).toEqual(['/tmp/flatfold-voice-x.m4a']);
	});

	it('rejects a short read rather than sending a truncated note', async () => {
		vi.stubGlobal('fetch', async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer }));
		const discarded: string[] = [];
		vi.stubGlobal('Capacitor', {
			convertFileSrc: (p: string) => p,
			Plugins: {
				FlatFoldAudio: {
					startRecording: async () => ({ mimeType: 'audio/mp4;codecs=mp4a.40.2' }),
					stopRecording: async () => ({ path: '/tmp/flatfold-voice-y.m4a', byteLength: 999 }),
					discardRecording: async ({ path }: { path: string }) => { discarded.push(path); },
				},
			},
		});
		const session = await recordNatively.start();
		await expect(session.stop()).rejects.toThrow(/incomplete/i);
		// Still cleaned up, even on failure.
		expect(discarded).toEqual(['/tmp/flatfold-voice-y.m4a']);
	});

	// The path a reviewer hits on first run if they decline the prompt.
	it('surfaces a denied permission as an actionable message, not a raw code', async () => {
		withPlugin({
			startRecording: async () => { throw Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' }); },
		});
		await expect(recordNatively.start()).rejects.toThrow(/System Settings|permission/i);
	});

	it('surfaces an empty recording rather than sending a zero-byte note', async () => {
		withPlugin({
			startRecording: async () => ({ mimeType: 'audio/mp4;codecs=mp4a.40.2' }),
			stopRecording: async () => { throw Object.assign(new Error('empty'), { code: 'EMPTY' }); },
		});
		const session = await recordNatively.start();
		await expect(session.stop()).rejects.toThrow(/nothing|empty/i);
	});
});

describe('a recording with no samples must never be sent', () => {
	// The Mac failure that looked like success: CoreAudio logged "client stopping
	// after failed start", `record()` still returned true, and AVAudioRecorder
	// still wrote a valid M4A header with a duration but no audio. The note sent
	// fine and played as silence — indistinguishable, on the receiving end, from
	// the codec bug this project already chased for three rounds.
	it('surfaces a failed input device instead of a silent note', async () => {
		withPlugin({
			startRecording: async () => ({ mimeType: 'audio/mp4;codecs=mp4a.40.2' }),
			stopRecording: async () => { throw Object.assign(new Error('no input'), { code: 'NO_INPUT' }); },
		});
		const session = await recordNatively.start();
		await expect(session.stop()).rejects.toThrow(/did not start|System Settings/i);
	});
});

describe('an unfinalized recording must never be sent', () => {
	// AVAudioRecorder.stop() is asynchronous. Reading the file on the next line
	// yielded every audio sample but no `moov` atom — the MPEG-4 index, written
	// at finalize. Size and metering both looked healthy (62,699 bytes, -17.3 dB
	// peak), so nothing native suggested a problem, while every receiving device
	// showed `--:--` and a spinner that never resolved.
	it('surfaces a failed finalize instead of an unplayable note', async () => {
		withPlugin({
			startRecording: async () => ({ mimeType: 'audio/mp4;codecs=mp4a.40.2' }),
			stopRecording: async () => { throw Object.assign(new Error('nope'), { code: 'FINALIZE_FAILED' }); },
		});
		const session = await recordNatively.start();
		await expect(session.stop()).rejects.toThrow(/could not be finished|try again/i);
	});
});

describe('a file that will not parse must never be sent', () => {
	// Byte count turned out to be a poor proxy for "playable": the file was
	// full-size (62,699 bytes, -17.3 dB peak) and still unusable because the
	// container was incomplete. The plugin now parses it with AVAudioFile — the
	// same way a player must — before handing it over.
	it('surfaces an unplayable recording rather than uploading it', async () => {
		withPlugin({
			startRecording: async () => ({ mimeType: 'audio/mp4;codecs=mp4a.40.2' }),
			stopRecording: async () => { throw Object.assign(new Error('bad'), { code: 'UNPLAYABLE' }); },
		});
		const session = await recordNatively.start();
		await expect(session.stop()).rejects.toThrow(/unplayable|try again/i);
	});
});

describe('the file-scheme read does not trust HTTP status', () => {
	// WKWebView's custom scheme handler may reply with a plain URLResponse rather
	// than an HTTPURLResponse. JS then sees status === 0 and ok === false on a
	// perfectly successful read — which is exactly what shipped as
	// "could not read the recording (0)". The BODY is the evidence, not the code.
	it('accepts a status-0 response that carries the bytes', async () => {
		const bytes = new Uint8Array([9, 8, 7]);
		vi.stubGlobal('fetch', async () => ({ ok: false, status: 0, arrayBuffer: async () => bytes.buffer }));
		vi.stubGlobal('Capacitor', { convertFileSrc: (p: string) => p, Plugins: {} });
		const { readRecordingFile } = await import('../src/lib/nativeAudio');
		expect(Array.from(await readRecordingFile('/tmp/flatfold-voice-z.m4a'))).toEqual([9, 8, 7]);
	});

	it('still fails when the read genuinely yields nothing', async () => {
		vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }));
		vi.stubGlobal('Capacitor', { convertFileSrc: (p: string) => p, Plugins: {} });
		const { readRecordingFile } = await import('../src/lib/nativeAudio');
		await expect(readRecordingFile('/tmp/flatfold-voice-z.m4a')).rejects.toThrow(/empty|could not read/i);
	});
});

describe('debug instrumentation does not ship', () => {
	// nativeLog/timed wrap the per-note decode path, so an ungated version makes
	// a Capacitor bridge round-trip per voice note in TestFlight and the App
	// Store. The NSLog compiles out of a Release build; the IPC does not.
	it('is silent unless the native DEBUG build opted in', async () => {
		const calls: string[] = [];
		vi.stubGlobal('Capacitor', { Plugins: { FlatFoldAudio: { debugLog: async ({ message }: { message: string }) => { calls.push(message); } } } });
		vi.stubGlobal('__flatfoldDebug', undefined);
		const { nativeLog, timed } = await import('../src/lib/nativeLog');
		nativeLog('should not appear');
		await timed('step', async () => 'x');
		expect(calls).toEqual([]);
	});

	it('reports when the DEBUG build did opt in', async () => {
		const calls: string[] = [];
		vi.stubGlobal('Capacitor', { Plugins: { FlatFoldAudio: { debugLog: async ({ message }: { message: string }) => { calls.push(message); } } } });
		vi.stubGlobal('__flatfoldDebug', true);
		const { nativeLog } = await import('../src/lib/nativeLog');
		nativeLog('hello');
		expect(calls).toEqual(['hello']);
	});
});
