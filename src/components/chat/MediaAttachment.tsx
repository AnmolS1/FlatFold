import { memo, useEffect, useRef, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import type { MediaRef } from '../../types';
import * as keystore from '../../keystore';
import { ackMediaFetched, downloadAndDecryptMedia } from '../../lib/media';
import { VoiceNote } from './VoiceNote';

interface MediaAttachmentProps {
	username: string;
	media: MediaRef;
	isOwnMessage: boolean;
}

// Inert raster image types only — deliberately EXCLUDES image/svg+xml (SVG can
// carry scripts and executes when opened as a top-level document).
const SAFE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']);

// Maps a (sender-controlled) MediaRef to a Blob MIME type we're willing to
// hand the browser. Returns null to reject. Never returns the sender's raw
// type for images (would allow HTML/SVG); files are always octet-stream.
function safeMimeType(media: MediaRef): string | null {
	const declared = (media.mimeType || '').toLowerCase().split(';')[0].trim();
	if (media.mediaKind === 'image') return SAFE_IMAGE_TYPES.has(declared) ? declared : null;
	if (media.mediaKind === 'voice') return declared.startsWith('audio/') ? declared : 'audio/webm';
	// Files: never interpret — download only.
	return 'application/octet-stream';
}

// Resolves an attachment to a local object URL: first from the encrypted
// media cache (survives reload; the R2 copy is deleted on fetch-ack), else by
// downloading + verifying + decrypting the R2 ciphertext, then caching it and
// acking the server copy away.
const MediaAttachmentComponent = ({ username, media, isOwnMessage }: MediaAttachmentProps) => {
	const [objectUrl, setObjectUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const urlRef = useRef<string | null>(null);

	useEffect(() => {
		let cancelled = false;

		const toUrl = (bytes: Uint8Array) => {
			// The MIME type is SENDER-CONTROLLED, and a blob: URL is same-origin:
			// a blob of text/html or image/svg+xml opened in a tab would execute
			// script in our origin (and could read the sessionStorage keystore
			// key). So NEVER trust the sender's type — derive a safe one from the
			// (also sender-controlled but coarse) mediaKind, and reject an image
			// whose declared type isn't a known-inert raster format. Forcing the
			// Blob type means even HTML/SVG bytes are interpreted inertly.
			const safeType = safeMimeType(media);
			if (safeType === null) {
				setError('Attachment type not allowed.');
				return;
			}
			// Copy into a fresh ArrayBuffer so the Blob part is unambiguously
			// ArrayBuffer-backed (never a SharedArrayBuffer view).
			const buffer = new ArrayBuffer(bytes.byteLength);
			new Uint8Array(buffer).set(bytes);
			const url = URL.createObjectURL(new Blob([buffer], { type: safeType }));
			urlRef.current = url;
			setObjectUrl(url);
		};

		(async () => {
			try {
				const cached = await keystore.getCachedMedia(username, media.id);
				if (cancelled) return;
				if (cached) {
					toUrl(cached.bytes);
					return;
				}
				const bytes = await downloadAndDecryptMedia(media);
				if (cancelled) return;
				await keystore.cacheMedia(username, media.id, bytes, media.mimeType);
				await ackMediaFetched(media.id); // server copy no longer needed
				if (cancelled) return;
				toUrl(bytes);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : 'Attachment unavailable.');
			}
		})();

		return () => {
			cancelled = true;
			if (urlRef.current) {
				URL.revokeObjectURL(urlRef.current);
				urlRef.current = null;
			}
		};
	}, [username, media]);

	if (error) {
		return <p className="text-xs italic opacity-70">{error}</p>;
	}
	if (!objectUrl) {
		return <p className="text-xs opacity-70">Loading attachment…</p>;
	}

	if (media.mediaKind === 'image') {
		return (
			<a href={objectUrl} target="_blank" rel="noopener noreferrer">
				<img src={objectUrl} alt={media.name ?? 'Image'} className="rounded-lg max-w-full max-h-64 object-contain" />
			</a>
		);
	}

	if (media.mediaKind === 'voice') {
		return <VoiceNote url={objectUrl} durationMs={media.durationMs} own={isOwnMessage} />;
	}

	// Generic file.
	return (
		<a
			href={objectUrl}
			download={media.name ?? 'attachment'}
			className="flex items-center gap-2 underline decoration-dotted"
		>
			<FileText className="w-4 h-4 flex-shrink-0" />
			<span className="text-sm truncate">{media.name ?? 'Download attachment'}</span>
			<Download className="w-3.5 h-3.5 flex-shrink-0 opacity-70" />
		</a>
	);
};

export const MediaAttachment = memo(MediaAttachmentComponent);
