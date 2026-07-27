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
 * How many notes may hold a media resource at once.
 *
 * WebKit caps concurrent media resources, and an element only costs a slot once
 * it has a `src`. Measured on Mac Catalyst: 28 mounted notes, each with `src`
 * and `preload="metadata"`, filled the pool — and the next note to be played
 * then hung at `readyState 0` / `networkState 2` indefinitely with `error`
 * still null, while four already-loaded notes were evicted to `networkState 3`
 * at that same instant. That is the whole of "old notes play, new ones don't".
 *
 * Three rather than one: the note playing, the one just paused (so resuming it
 * does not re-download and lose position), and one spare for a quick A/B
 * between two notes. Small enough that the pool is never the binding constraint.
 */
export const LOADED_NOTE_LIMIT = 3;

// Least-recently-used first. Module scope on purpose: the limit is a property of
// the WebView process, not of any one conversation or component tree.
const loaded: HTMLAudioElement[] = [];

/** Release a note's media resource. Removing `src` alone does not free it. */
function release(el: HTMLAudioElement) {
	el.removeAttribute('src');
	// `load()` is what actually tears the resource down — without it WebKit keeps
	// the old one alive and the cap achieves nothing.
	el.load();
}

/**
 * Give this element a media resource, evicting the least-recently-used if the
 * pool is full.
 *
 * Never evicts an element that is still playing: the cap exists to stop notes
 * hanging, and stopping the note the user is listening to would be a worse bug
 * than the one being fixed.
 */
function claimSlot(el: HTMLAudioElement, url: string) {
	const existing = loaded.indexOf(el);
	if (existing !== -1) loaded.splice(existing, 1);
	else el.src = url;
	loaded.push(el);

	while (loaded.length > LOADED_NOTE_LIMIT) {
		const victim = loaded.findIndex((c) => c !== el && c.paused);
		if (victim === -1) break;
		release(loaded[victim]);
		loaded.splice(victim, 1);
	}
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
// THE MEDIA ELEMENT IS RENDERED IN JSX, PER NOTE, DELIBERATELY — but it carries
// no `src` until the note is played. Those are two separate decisions and both
// were paid for.
//
// The ELEMENT stays in JSX because a single shared element, constructed
// imperatively at module scope, was tried and reverted: it never lived in the
// document, and WebKit does not load a DETACHED media element. No fetch, no
// `loadedmetadata`, no `error`, and a play() that neither resolved nor rejected.
// Appending it to document.body afterwards did not revive it.
//
// The SOURCE is attached lazily because an element with a `src` holds a media
// resource, and WebKit's pool of those is small. See LOADED_NOTE_LIMIT.
//
// Worth knowing how this failure presents, because it wasted two debugging
// rounds: the note that cannot get a slot HANGS — readyState 0, networkState 2,
// `error` null — while OTHER, already-loaded notes are evicted and report
// MEDIA_ERR_SRC_NOT_SUPPORTED (code 4). So the visible error belongs to a
// different note than the broken one, and code 4 reads as a codec problem when
// nothing is wrong with the codec. Always attribute a media error to a specific
// note before believing it.
export const VoiceNote = ({ url, durationMs, own, mimeType }: VoiceNoteProps) => {
	const audioRef = useRef<HTMLAudioElement>(null);
	const [bars, setBars] = useState<number[] | null>(null);
	const [playing, setPlaying] = useState(false);
	const [progress, setProgress] = useState(0); // 0..1
	const [duration, setDuration] = useState(durationMs ? durationMs / 1000 : 0);
	const [playbackError, setPlaybackError] = useState<string | null>(null);

	// A short, stable label for this note in the debug log. The blob URL's last
	// segment is unique per note and carries no message content.
	const noteTag = url.slice(-6);

	// Drop this note out of the pool when it unmounts. Without it the registry
	// keeps references to detached elements, which both leaks them and lets the
	// cap be consumed by notes that scrolled out of the list — reintroducing the
	// exhaustion from the other end.
	useEffect(() => {
		const el = audioRef.current;
		return () => {
			if (!el) return;
			const at = loaded.indexOf(el);
			if (at !== -1) loaded.splice(at, 1);
		};
	}, []);

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
		if (!el) return;
		nativeLog(`[${noteTag}] toggle paused=${el.paused} ready=${el.readyState} net=${el.networkState} err=${el.error?.code ?? '-'}`);
		if (el.paused) {
			// Claim the resource here, on the gesture, and imperatively.
			//
			// Not via React state: an earlier attempt set `src` through a re-render
			// and then called play() against an element the render had not updated
			// yet, which raced and silently did nothing. Setting it on the ref
			// means the element is ready on the very next line.
			claimSlot(el, url);
			void el.play().catch((err: unknown) => {
				// AbortError is benign — pausing aborts a play() that has not started.
				const name = err instanceof Error ? err.name : '';
				if (name === 'AbortError') return;
				nativeLog(`play() rejected: ${name}`);
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
				<audio
					ref={audioRef}
					// NO `src`, and preload="none": an <audio> costs a media
					// resource the moment it has a source, and a conversation
					// mounts one per note. See LOADED_NOTE_LIMIT above — this is
					// the fix for notes that hang instead of playing.
					//
					// The duration shown while unloaded comes from `durationMs`,
					// which rides inside the MediaRef and so is present on
					// RECEIVED notes too, not only ones recorded on this device.
					// An earlier attempt at lazy loading regressed the duration to
					// 0:00 — but that was before the CSP `connect-src blob:` fix,
					// when the waveform decode (the other duration source) was
					// failing on every platform.
					preload="none"
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
