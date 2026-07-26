// Which container to record voice notes in.
//
// This exists because it used to be nobody's decision. `new MediaRecorder(stream)`
// with no options lets the browser choose, and browsers disagree in a way that
// is not recoverable at playback time:
//
//   Chrome / Firefox record  audio/webm;codecs=opus  (Firefox also audio/ogg)
//   Safari / WKWebView       audio/mp4  (AAC)
//
// Safari and WKWebView cannot decode WebM or Ogg at all. So a voice note
// recorded in desktop Chrome was unplayable on every Apple device — iPhone
// included — and failed silently on the receiving end, which is the worst place
// for it to fail.
//
// There is no container that every browser can both record and play, so the tie
// is broken in favour of the side that cannot fall back: prefer a format Apple
// can play. MP4/AAC is decodable by Safari, Chrome and Firefox alike; the only
// gap left is Firefox, which cannot RECORD it, and whose notes therefore stay
// Apple-unplayable. That residual is real and the sender is told about it rather
// than the receiver discovering it.

/**
 * Types Safari / WKWebView can actually decode, most-preferred first.
 *
 * The AAC codec is named EXPLICITLY, and that is load-bearing rather than
 * pedantic. Verified against a real Chromium: `isTypeSupported` returns true for
 * `audio/mp4`, `audio/mp4;codecs=mp4a.40.2` AND `audio/mp4;codecs=opus`. Asking
 * for the bare container therefore lets Chrome choose Opus-in-MP4 — an MP4 that
 * Safari still cannot play. The first version of this fix did exactly that, so
 * it looked applied and changed nothing.
 */
export const APPLE_PLAYABLE = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac', 'audio/mpeg'] as const;

/** Codecs that defeat an otherwise-Apple-playable container. */
const APPLE_HOSTILE_CODECS = ['opus', 'vorbis'];

/** Everything else we would accept, least-bad first. Apple cannot play these. */
const FALLBACKS = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'] as const;

type SupportCheck = (mimeType: string) => boolean;

function defaultSupportCheck(mimeType: string): boolean {
	return typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
		? MediaRecorder.isTypeSupported(mimeType)
		: false;
}

/**
 * The best container this browser can record in, preferring Apple-playable ones.
 *
 * Returns null when nothing on either list is supported — the caller should then
 * construct MediaRecorder with no options and let the browser decide, which is
 * strictly better than forcing a type it will reject.
 */
export function pickRecordingMimeType(isSupported: SupportCheck = defaultSupportCheck): string | null {
	for (const candidate of [...APPLE_PLAYABLE, ...FALLBACKS]) {
		if (isSupported(candidate)) return candidate;
	}
	return null;
}

/**
 * Whether a recorded/received note will play on Safari and WKWebView.
 *
 * Checks the codec as well as the container, because `audio/mp4;codecs=opus` is
 * an Apple-playable container carrying a codec Apple cannot decode.
 */
export function isApplePlayable(mimeType: string): boolean {
	const lower = mimeType.toLowerCase();
	const base = lower.split(';')[0].trim();
	const containerOk = (APPLE_PLAYABLE as readonly string[]).some((t) => t.split(';')[0] === base);
	if (!containerOk) return false;
	const codecs = /codecs\s*=\s*"?([^";]+)/.exec(lower)?.[1] ?? '';
	return !APPLE_HOSTILE_CODECS.some((c) => codecs.includes(c));
}
