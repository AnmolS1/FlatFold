import { useEffect, useState, useSyncExternalStore } from 'react';
import { Play, Pause } from 'lucide-react';
import { getSharedAudioContext, decodeAudioLimited } from '../../lib/audioContext';
import {
	sharedPlayerState,
	subscribeSharedPlayer,
	toggleSharedPlayback,
	releaseSharedPlayback,
} from '../../lib/audioPlayer';
import { describeVoiceNotePlaybackError } from '../../lib/mediaErrors';

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

// A voice note: a hand-rolled waveform (Web Audio decode → bars), a play/pause
// button, and a duration.
//
// It renders no media element of its own, and that is the point. Every note
// owning one exhausted WebKit's media-resource pool in a busy conversation, and
// the failure surfaced as MEDIA_ERR_SRC_NOT_SUPPORTED — a codec error that was
// never a codec problem. Capping decodes and preloading metadata only each
// helped and neither was enough, because the cost scaled with how many notes
// were RENDERED rather than how many were played.
//
// Playback goes through the single shared element in lib/audioPlayer. Only one
// voice note can play at a time, so more than one element was never needed.
export const VoiceNote = ({ url, durationMs, own, mimeType }: VoiceNoteProps) => {
	const [bars, setBars] = useState<number[] | null>(null);
	const [decodedDuration, setDecodedDuration] = useState(0);

	const player = useSyncExternalStore(subscribeSharedPlayer, sharedPlayerState, sharedPlayerState);
	const isCurrent = player.url === url;
	const playing = isCurrent && player.playing;
	const progress = isCurrent && player.duration > 0 ? player.currentTime / player.duration : 0;

	// Duration, best source first: what the sender recorded, then what we decoded
	// for the waveform, then whatever the player learned once it loaded this note.
	// Never depends on a media element existing, which is why it no longer reads
	// 00:00 for notes that have not been played.
	const duration = durationMs ? durationMs / 1000 : decodedDuration || (isCurrent ? player.duration : 0);

	const playbackError =
		isCurrent && player.errorCode !== undefined ? describeVoiceNotePlaybackError(player.errorCode, mimeType) : null;

	// Decode once for the waveform. Any failure degrades to flat bars and is
	// deliberately NOT allowed to affect playback: the old code swapped in a
	// second media element on decode failure, which doubled the resource cost
	// at exactly the moment resources were already short.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const ctx = getSharedAudioContext();
				if (!ctx) return;
				const decoded = await decodeAudioLimited(async () => {
					const buf = await (await fetch(url)).arrayBuffer();
					return ctx.decodeAudioData(buf);
				});
				if (cancelled) return;
				setBars(peaksFrom(decoded.getChannelData(0)));
				setDecodedDuration(decoded.duration);
			} catch {
				// Flat bars; still playable.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [url]);

	// Hand the shared element back if this note unmounts while holding it.
	useEffect(() => () => releaseSharedPlayback(url), [url]);

	const accent = own ? 'bg-on-crease' : 'bg-crease';
	const dim = own ? 'bg-on-crease/35' : 'bg-crease/30';

	return (
		<div className="flex flex-col gap-1 min-w-[12rem]">
			<div className="flex items-center gap-3">
				<button
					onClick={() => void toggleSharedPlayback(url)}
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
