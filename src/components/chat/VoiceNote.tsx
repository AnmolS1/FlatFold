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
// THE MEDIA ELEMENT IS RENDERED IN JSX, PER NOTE, DELIBERATELY.
//
// A single shared element, constructed imperatively at module scope, was tried
// and reverted. It never lived in the document, and WebKit does not load a
// DETACHED media element: no fetch, no `loadedmetadata`, no `error`, and a
// play() that neither resolved nor rejected. Playback died completely and
// silently, and appending it to document.body afterwards did not revive it.
// Per-note elements in JSX are the arrangement that has always worked.
//
// The reason the shared element was attempted — WebKit's cap on concurrent media
// resources, which surfaced as MEDIA_ERR_SRC_NOT_SUPPORTED and reads as a codec
// error — is real, and is mitigated here instead by preloading metadata only and
// by NOT creating a second element when the waveform decode fails.
export const VoiceNote = ({ url, durationMs, own, mimeType }: VoiceNoteProps) => {
	const audioRef = useRef<HTMLAudioElement>(null);
	const [bars, setBars] = useState<number[] | null>(null);
	const [playing, setPlaying] = useState(false);
	const [progress, setProgress] = useState(0); // 0..1
	const [duration, setDuration] = useState(durationMs ? durationMs / 1000 : 0);
	const [playbackError, setPlaybackError] = useState<string | null>(null);

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
				nativeLog(`waveform decode failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [url, durationMs]);

	const toggle = () => {
		const el = audioRef.current;
		if (!el) return;
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
	};

	const accent = own ? 'bg-on-crease' : 'bg-crease';
	const dim = own ? 'bg-on-crease/35' : 'bg-crease/30';

	return (
		<div className="flex flex-col gap-1 min-w-[12rem]">
			<div className="flex items-center gap-3">
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
						nativeLog(`audio loadedmetadata duration=${e.currentTarget.duration}`);
						if (!durationMs && isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
					}}
					onError={() => {
						const code = audioRef.current?.error?.code;
						nativeLog(`audio element error code=${code ?? '?'}`);
						setPlaybackError(describeVoiceNotePlaybackError(code, mimeType));
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
