import { useEffect, useRef, useState } from 'react';
import { Play, Pause } from 'lucide-react';

interface VoiceNoteProps {
	url: string; // blob: object URL of the decrypted audio
	durationMs?: number;
	own: boolean;
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

// A voice note rendered as a hand-rolled waveform (Web Audio decode → bars) with
// a play/pause button and a mono duration. Falls back to the native <audio>
// player if decoding fails (e.g. Safari + opus), so playback always works.
export const VoiceNote = ({ url, durationMs, own }: VoiceNoteProps) => {
	const audioRef = useRef<HTMLAudioElement>(null);
	const [bars, setBars] = useState<number[] | null>(null);
	const [decodeFailed, setDecodeFailed] = useState(false);
	const [playing, setPlaying] = useState(false);
	const [progress, setProgress] = useState(0); // 0..1
	const [duration, setDuration] = useState(durationMs ? durationMs / 1000 : 0);

	// Decode the audio to a waveform once. Guarded: any failure degrades to the
	// native player rather than throwing.
	useEffect(() => {
		let cancelled = false;
		let ctx: AudioContext | null = null;
		(async () => {
			try {
				const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
				if (!AC) throw new Error('no AudioContext');
				ctx = new AC();
				const buf = await (await fetch(url)).arrayBuffer();
				const decoded = await ctx.decodeAudioData(buf);
				if (cancelled) return;
				setBars(peaksFrom(decoded.getChannelData(0)));
				if (!durationMs) setDuration(decoded.duration);
			} catch {
				if (!cancelled) setDecodeFailed(true);
			} finally {
				void ctx?.close();
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [url, durationMs]);

	const toggle = () => {
		const el = audioRef.current;
		if (!el) return;
		if (el.paused) void el.play();
		else el.pause();
	};

	// Native fallback: decoding failed, but playback still works.
	if (decodeFailed) {
		return <audio src={url} controls className="h-8 max-w-full" />;
	}

	const accent = own ? 'bg-white' : 'bg-crease';
	const dim = own ? 'bg-white/35' : 'bg-crease/30';

	return (
		<div className="flex items-center gap-3 min-w-[12rem]">
			<audio
				ref={audioRef}
				src={url}
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
					if (!durationMs && isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
				}}
				className="hidden"
			/>
			<button
				onClick={toggle}
				aria-label={playing ? 'Pause voice note' : 'Play voice note'}
				className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${own ? 'bg-white/20 text-white' : 'bg-crease/15 text-crease'}`}
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

			<span className={`flex-shrink-0 font-mono text-xs ${own ? 'text-white/70' : 'text-graphite-40'}`}>{formatDuration(duration)}</span>
		</div>
	);
};
