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
	it('returns bytes and the pinned Apple-playable mime type', async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		withPlugin({
			startRecording: async () => ({ mimeType: 'audio/mp4;codecs=mp4a.40.2' }),
			stopRecording: async () => ({
				base64: btoa(String.fromCharCode(...bytes)),
				mimeType: 'audio/mp4;codecs=mp4a.40.2',
				durationMs: 1500,
			}),
		});
		const session = await recordNatively.start();
		const result = await session.stop();
		expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
		expect(result.durationMs).toBe(1500);
		// Must match what audioFormat.ts requires, or Apple devices can't play it.
		expect(result.mimeType).toBe('audio/mp4;codecs=mp4a.40.2');
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
