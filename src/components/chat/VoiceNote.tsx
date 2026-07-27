import { useEffect, useRef, useState } from 'react';
import { Play, Pause } from 'lucide-react';
import { getSharedAudioContext, decodeAudioLimited } from '../../lib/audioContext';
import { describeVoiceNotePlaybackError } from '../../lib/mediaErrors';
import { nativeLog, timed } from '../../lib/nativeLog';

interface VoiceNoteProps {
	url: string; // blob: object URL of the decrypted audio
	durationMs?: number;
	own: boolean;
	/** Declared type of the recording, so a failure can name the format. */
	mimeType?: string;
}

const BAR_COUNT = 40;

/**
 * How many notes may have a live `<audio>` ELEMENT at once.
 *
 * The budget WebKit enforces appears to be on media elements themselves, not on
 * how many of them have loaded. Measured on Mac Catalyst: a conversation with 37
 * voice notes rendered 37 `<audio>` elements; 31 reached `readyState 1` and the
 * last 6 sat at `networkState 2` / `readyState 0` indefinitely with `error`
 * still null — never loading, and never failing either.
 *
 * That ceiling explains all three symptoms that were chased separately:
 *   - the tail of a long conversation is dead (elements past the limit)
 *   - a newly ARRIVED note never plays (it is element 38)
 *   - withholding `src` from all 37 elements changed nothing, because the
 *     elements had already spent the budget. That attempt was reverted.
 *
 * So the element must not EXIST until the note is played, and old ones must be
 * torn down to make room. Six is far below the observed ceiling while still
 * covering the note playing, the one just paused, and a few recently visited.
 */
export const LIVE_NOTE_LIMIT = 6;

// Notes with a live element, least-recently-used first. Module scope because the
// budget belongs to the WebView process, not to a conversation or a subtree.
const live: Array<() => void> = [];

/**
 * Register this note as live, retiring the least-recently-used past the limit.
 *
 * Takes a teardown callback rather than an element: unmounting is what frees the
 * budget here, and only the component can do that.
 */
function goLive(retire: () => void): () => void {
	live.push(retire);
	while (live.length > LIVE_NOTE_LIMIT) live.shift()?.();
	return () => {
		const at = live.indexOf(retire);
		if (at !== -1) live.splice(at, 1);
	};
}

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

// A voice note: a waveform, a play/pause button, and a duration.
//
// THE MEDIA ELEMENT IS CREATED ON THE PLAY GESTURE, NOT AT MOUNT. See
// LIVE_NOTE_LIMIT — a conversation renders one of these per note, and beyond a
// ceiling of about 31 they simply never load.
//
// When it does exist it is rendered in JSX, so it is attached to the document by
// construction. That part is not incidental: a single shared element built
// imperatively at module scope was tried and reverted, because WebKit does not
// load a DETACHED media element at all — no fetch, no `loadedmetadata`, no
// `error`, and a play() that neither resolved nor rejected. Appending it to
// document.body afterwards did not revive it.
//
// Worth knowing how the ceiling PRESENTS, because it cost two debugging rounds:
// the note that cannot get a slot HANGS silently — readyState 0, networkState 2,
// `error` null — while OTHER, already-loaded notes are evicted and report
// MEDIA_ERR_SRC_NOT_SUPPORTED (code 4). So the visible error belongs to a
// different note than the broken one, and code 4 reads as a codec fault when the
// codec is fine. Always attribute a media error to a specific note first.
export const VoiceNote = ({ url, durationMs, own, mimeType }: VoiceNoteProps) => {
	const audioRef = useRef<HTMLAudioElement>(null);
	const [bars, setBars] = useState<number[] | null>(null);
	const [playing, setPlaying] = useState(false);
	const [progress, setProgress] = useState(0); // 0..1
	const [duration, setDuration] = useState(durationMs ? durationMs / 1000 : 0);
	const [playbackError, setPlaybackError] = useState<string | null>(null);
	// Whether this note has a media element at all. False until first played.
	const [liveEl, setLiveEl] = useState(false);
	// Set when the element is created BY a play gesture, so the effect below
	// knows to start playback as soon as the element exists.
	const playOnMount = useRef(false);
	const unregister = useRef<(() => void) | null>(null);

	// A short, stable label for this note in the debug log. The blob URL's last
	// segment is unique per note and carries no message content.
	const noteTag = url.slice(-6);

	// Start playback once the element exists.
	//
	// This runs in the commit for the click that set `liveEl`, so the user
	// activation that WebKit requires for play() is still in force. Doing it here
	// rather than in the handler is what makes create-then-play work at all: in
	// the handler there is no element yet.
	useEffect(() => {
		if (!liveEl || !playOnMount.current) return;
		playOnMount.current = false;
		const el = audioRef.current;
		if (!el) return;
		nativeLog(`[${noteTag}] element created, playing`);
		void el.play().catch((err: unknown) => {
			const name = err instanceof Error ? err.name : '';
			if (name === 'AbortError') return;
			nativeLog(`[${noteTag}] play() rejected: ${name}`);
		});
	}, [liveEl, noteTag]);

	// Give the budget back when this note leaves the list.
	useEffect(() => () => unregister.current?.(), []);

	// Decode once for the waveform. Failure degrades to flat bars and MUST NOT
	// affect playback: the old code swapped in a second media element here, which
	// doubled the resource cost exactly when resources were already short.
	//
	// On the Mac passthrough this currently always fails with "Decoding failed" —
	// that runtime's Web Audio will not decode this AAC. Cosmetic: the <audio>
	// element below uses a different decoder and is unaffected.
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
				if (!durationMs) setDuration(decoded.duration);
			} catch (err) {
				nativeLog(`[${url.slice(-6)}] waveform decode failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [url, durationMs]);

	const toggle = () => {
		const el = audioRef.current;

		// First play: there is no element yet. Create one, claim a slot in the
		// budget, and let the effect above start it once React has committed.
		if (!el) {
			nativeLog(`[${noteTag}] arming (live=${live.length})`);
			playOnMount.current = true;
			unregister.current = goLive(() => {
				unregister.current = null;
				setLiveEl(false);
			});
			setLiveEl(true);
			return;
		}

		nativeLog(`[${noteTag}] toggle paused=${el.paused} ready=${el.readyState} net=${el.networkState} err=${el.error?.code ?? '-'}`);
		if (el.paused) {
			void el.play().catch((err: unknown) => {
				// AbortError is benign — pausing aborts a play() that has not started.
				const name = err instanceof Error ? err.name : '';
				if (name === 'AbortError') return;
				nativeLog(`[${noteTag}] play() rejected: ${name}`);
			});
		} else {
			el.pause();
		}
	};

	const accent = own ? 'bg-on-crease' : 'bg-crease';
	const dim = own ? 'bg-on-crease/35' : 'bg-crease/30';

	return (
		<div className="flex flex-col gap-1 min-w-[12rem]">
			<div className="flex items-center gap-3">
				{/* Only once played, and torn down again when the budget needs
				    the slot. An element that does not exist cannot consume the
				    ceiling that stops other notes loading. */}
				{liveEl && (
				<audio
					ref={audioRef}
					src={url}
					preload="metadata"
					playsInline
					onPlay={() => setPlaying(true)}
					onPause={() => setPlaying(false)}
					onEnded={() => {
						setPlaying(false);
						setProgress(0);
					}}
					onTimeUpdate={(e) => {
						const el = e.currentTarget;
						if (el.duration) setProgress(el.currentTime / el.duration);
					}}
					onLoadedMetadata={(e) => {
						nativeLog(`[${noteTag}] loadedmetadata duration=${e.currentTarget.duration}`);
						if (!durationMs && isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
					}}
					onError={() => {
						const el = audioRef.current;
						// Tagged, because a conversation renders one <audio> per note
						// and an untagged "error code=4" cannot be attributed to any
						// of them. Two rounds were spent reading these as the newest
						// note's failure without ever establishing that they were.
						nativeLog(`[${noteTag}] error code=${el?.error?.code ?? '?'} ready=${el?.readyState} net=${el?.networkState}`);
						setPlaybackError(describeVoiceNotePlaybackError(el?.error?.code, mimeType));
					}}
					className="hidden"
				/>
				)}
				<button
					onClick={toggle}
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

				<span className={`flex-shrink-0 font-mono text-xs ${own ? 'text-on-crease-dim' : 'text-graphite-40'}`}>{formatDuration(duration)}</span>
			</div>
			{playbackError && <p className="text-xs italic opacity-70">{playbackError}</p>}
		</div>
	);
};
