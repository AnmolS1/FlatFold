import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Play, Pause } from 'lucide-react';
import { getSharedAudioContext, decodeAudioLimited } from '../../lib/audioContext';
import { describeVoiceNotePlaybackError } from '../../lib/mediaErrors';
import { nativeLog, timed } from '../../lib/nativeLog';
import { nativePlaybackSupported } from '../../lib/nativeAudio';
import { voicePlayer } from '../../lib/voicePlayer';

interface VoiceNoteProps {
	/**
	 * Stable identity for this note — the `MediaRef.id`, NOT the blob URL.
	 *
	 * The URL is created and revoked by `MediaAttachment`'s effect, so it changes
	 * whenever the attachment remounts. Keying the saved playback position on it
	 * would silently lose the position exactly when a note scrolls away and back.
	 */
	noteId: string;
	url: string; // blob: object URL of the decrypted audio
	durationMs?: number;
	own: boolean;
	/** Declared type of the recording, so a failure can name the format. */
	mimeType?: string;
}

const BAR_COUNT = 40;

function formatDuration(seconds: number): string {
	if (!isFinite(seconds) || seconds < 0) return '0:00';
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${s.toString().padStart(2, '0')}`;
}

// Downsample decoded PCM to BAR_COUNT normalized peak amplitudes (0..1).
function peaksFrom(channel: Float32Array): number[] {
	const block = Math.floor(channel.length / BAR_COUNT) || 1;
	const peaks: number[] = [];
	let max = 0;
	for (let i = 0; i < BAR_COUNT; i++) {
		let peak = 0;
		const start = i * block;
		for (let j = 0; j < block && start + j < channel.length; j++) {
			const v = Math.abs(channel[start + j]);
			if (v > peak) peak = v;
		}
		peaks.push(peak);
		if (peak > max) max = peak;
	}
	// Normalize so the loudest bar is full-height; floor tiny bars so silence
	// still shows a faint tick rather than nothing.
	return peaks.map((p) => (max > 0 ? Math.max(0.06, p / max) : 0.06));
}

/**
 * Decode once for the waveform. Failure degrades to flat bars and MUST NOT
 * affect playback: the old code swapped in a second media element here, which
 * doubled the resource cost exactly when resources were already short.
 *
 * On a Mac this always fails with "Decoding failed" — that runtime's Web Audio
 * will not decode this AAC. Cosmetic, and unrelated to whether the note plays:
 * both backends below use a different decoder. The durable fix is peaks computed
 * by the SENDER and shipped in the MediaRef, which is a payload-schema change.
 */
function useWaveform(url: string, durationMs?: number) {
	const [bars, setBars] = useState<number[] | null>(null);
	const [decodedDuration, setDecodedDuration] = useState(0);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const ctx = getSharedAudioContext();
				if (!ctx) return;
				const decoded = await decodeAudioLimited(async () => {
					const buf = await timed('waveform fetch', async () => (await fetch(url)).arrayBuffer());
					return timed('decodeAudioData', () => ctx.decodeAudioData(buf));
				});
				if (cancelled) return;
				setBars(peaksFrom(decoded.getChannelData(0)));
				if (!durationMs) setDecodedDuration(decoded.duration);
			} catch (err) {
				nativeLog(`[${url.slice(-6)}] waveform decode failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [url, durationMs]);

	return { bars, decodedDuration };
}

interface ViewProps {
	url: string;
	durationMs?: number;
	own: boolean;
	playing: boolean;
	/** Seconds into the note. */
	currentTime: number;
	/** Seconds, from the backend. 0 until it knows, which is when the props win. */
	duration: number;
	error: string | null;
	onToggle: () => void;
}

// The visible note: a waveform, a play/pause button, and a duration. Owns no
// transport — both backends below render this, which is what keeps them from
// drifting into two different-looking voice notes.
const VoiceNoteView = ({ url, durationMs, own, playing, currentTime, duration, error, onToggle }: ViewProps) => {
	const { bars, decodedDuration } = useWaveform(url, durationMs);

	// The BACKEND's duration wins when it has one. On a Mac that is
	// `AVAudioPlayer.duration`, which is measured from the actual samples — the
	// sender's `durationMs` is sampled before the recorder stops and overstates
	// by ~27%, and it is baked into the MediaRef, so every receiving device
	// inherits the same wrong number until the recorder is fixed separately.
	const shown = duration || (durationMs ? durationMs / 1000 : decodedDuration);
	const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

	const accent = own ? 'bg-on-crease' : 'bg-crease';
	const dim = own ? 'bg-on-crease/35' : 'bg-crease/30';

	return (
		<div className="flex flex-col gap-1 min-w-[12rem]">
			<div className="flex items-center gap-3">
				<button
					onClick={onToggle}
					aria-label={playing ? 'Pause voice note' : 'Play voice note'}
					className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${own ? 'bg-on-crease/20 text-on-crease' : 'bg-crease/15 text-crease'}`}
				>
					{playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 translate-x-[1px]" />}
				</button>

				{/* Waveform: bars filled up to the play cursor. */}
				<div className="flex items-center gap-[2px] h-8 flex-1" aria-hidden="true">
					{(bars ?? Array.from({ length: BAR_COUNT }, () => 0.3)).map((h, i) => {
						const filled = i / BAR_COUNT <= progress;
						return <span key={i} className={`w-[2px] rounded-full ${filled ? accent : dim}`} style={{ height: `${Math.round(h * 100)}%` }} />;
					})}
				</div>

				<span className={`flex-shrink-0 font-mono text-xs ${own ? 'text-on-crease-dim' : 'text-graphite-40'}`}>{formatDuration(shown)}</span>
			</div>
			{error && <p className="text-xs italic opacity-70">{error}</p>}
		</div>
	);
};

/**
 * Mac: play in Swift, and render NO `<audio>` at all.
 *
 * That absence is the entire fix. On a Mac, WKWebView grants media loaders in a
 * window tied to page load, capped at ~30 and never reclaimed within the page —
 * so in a long conversation the tail simply never plays, and a note that ARRIVES
 * after the page loaded never plays at all. Nothing arranged inside the web view
 * changes that, because the web view is the constraint; ~60 trials across five
 * conditions are recorded in docs/redesign/MAC_AUDIO_FINDINGS.md, along with the
 * eleven models that were refuted on the way. An element rendered here, even one
 * never played, would take a grant from the pool.
 *
 * Transport state lives in `voicePlayer` rather than here because the native
 * player is a singleton: one `AVAudioPlayer` behind forty components.
 */
const NativeVoiceNote = ({ noteId, url, durationMs, own, mimeType }: VoiceNoteProps) => {
	const [error, setError] = useState<string | null>(null);

	// Subscribed PER NOTE, not to the store as a whole: progress ticks at ~10 Hz,
	// and a store-wide notification would re-render every note in the
	// conversation ten times a second to move one cursor.
	const state = useSyncExternalStore(
		useCallback((cb: () => void) => voicePlayer.subscribe(noteId, cb), [noteId]),
		useCallback(() => voicePlayer.getState(noteId), [noteId])
	);

	const toggle = useCallback(() => {
		setError(null);
		// The loader is only called when the bytes are actually needed — resuming
		// a note the plugin still holds sends no payload at all.
		voicePlayer
			.toggle(noteId, async () => new Uint8Array(await (await fetch(url)).arrayBuffer()))
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				nativeLog(`[${noteId}] native play failed: ${message}`);
				setError(message || describeVoiceNotePlaybackError(undefined, mimeType));
			});
	}, [noteId, url, mimeType]);

	return (
		<VoiceNoteView
			url={url}
			durationMs={durationMs}
			own={own}
			playing={state.playing}
			currentTime={state.currentTime}
			duration={state.duration}
			error={error}
			onToggle={toggle}
		/>
	);
};

/**
 * Everywhere else: the `<audio>` element, unchanged.
 *
 * Verified 2026-07-28 on a real iPhone that iOS does NOT have the Mac's loader
 * cap — every note in the same 40-note conversation played. iOS is the shipped
 * target, so this path is deliberately left alone rather than churned onto a
 * backend that only one platform needs.
 *
 * `src` IS SET AT MOUNT. Attaching it on the play gesture instead was shipped
 * and reverted twice (`dd31836`, `347944c`): it makes every load a late one,
 * which is strictly worse. Do not re-try it without new evidence.
 *
 * Worth knowing how the Mac failure used to present here, because it cost two
 * debugging rounds: the note that cannot get a slot HANGS — readyState 0,
 * networkState 2, `error` null — while OTHER, already-loaded notes are evicted
 * and report MEDIA_ERR_SRC_NOT_SUPPORTED (code 4). So the visible error belongs
 * to a different note than the broken one, and code 4 reads as a codec problem
 * when nothing is wrong with the codec.
 */
const WebVoiceNote = ({ url, durationMs, own, mimeType }: VoiceNoteProps) => {
	const [el, setEl] = useState<HTMLAudioElement | null>(null);
	const [playing, setPlaying] = useState(false);
	const [currentTime, setCurrentTime] = useState(0);
	const [duration, setDuration] = useState(durationMs ? durationMs / 1000 : 0);
	const [error, setError] = useState<string | null>(null);

	// A short, stable label for this note in the debug log. The blob URL's last
	// segment is unique per note and carries no message content.
	const noteTag = url.slice(-6);

	const toggle = useCallback(() => {
		if (!el) return;
		nativeLog(`[${noteTag}] toggle paused=${el.paused} ready=${el.readyState} net=${el.networkState} err=${el.error?.code ?? '-'}`);
		if (el.paused) {
			void el.play().catch((err: unknown) => {
				// AbortError is benign — pausing aborts a play() that has not started.
				const name = err instanceof Error ? err.name : '';
				if (name === 'AbortError') return;
				nativeLog(`play() rejected: ${name}`);
			});
		} else {
			el.pause();
		}
	}, [el, noteTag]);

	return (
		<>
			<audio
				ref={setEl}
				src={url}
				preload="metadata"
				playsInline
				onPlay={() => setPlaying(true)}
				onPause={() => setPlaying(false)}
				onEnded={() => {
					setPlaying(false);
					setCurrentTime(0);
				}}
				onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
				onLoadedMetadata={(e) => {
					nativeLog(`[${noteTag}] loadedmetadata duration=${e.currentTarget.duration}`);
					if (isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
				}}
				onError={() => {
					// Tagged, because a conversation renders one <audio> per note and
					// an untagged "error code=4" cannot be attributed to any of them.
					nativeLog(`[${noteTag}] error code=${el?.error?.code ?? '?'} ready=${el?.readyState} net=${el?.networkState}`);
					setError(describeVoiceNotePlaybackError(el?.error?.code, mimeType));
				}}
				className="hidden"
			/>
			<VoiceNoteView
				url={url}
				durationMs={durationMs}
				own={own}
				playing={playing}
				currentTime={currentTime}
				duration={duration}
				error={error}
				onToggle={toggle}
			/>
		</>
	);
};

// One component, two backends. The choice is a SYNCHRONOUS read of a flag the
// native shell injects at document start — see `nativePlaybackSupported`. It has
// to be synchronous: an async capability check would render the `<audio>` branch
// first and spend the loader grant the native branch exists to avoid.
export const VoiceNote = (props: VoiceNoteProps) =>
	nativePlaybackSupported() ? <NativeVoiceNote {...props} /> : <WebVoiceNote {...props} />;
