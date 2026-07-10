// Building the compact quote (ReplyRef) that rides inside a reply's E2EE
// payload. Pure so the snippet/truncation rules can be unit tested. The quote
// is display-only — the recipient renders it as text above the reply bubble.

import type { DisplayMessage, ReplyRef } from '../types';

const SNIPPET_MAX = 120;

// A short, human-readable snippet of a message for use inside a reply quote or
// a preview. Media becomes a label; a tombstoned message becomes a neutral
// note; text is trimmed to SNIPPET_MAX so a reply-to-a-wall-of-text stays small.
export function replySnippet(message: DisplayMessage): string {
	if (message.deleted) return 'Deleted message';
	if (message.media) {
		if (message.media.mediaKind === 'voice') return 'Voice note';
		if (message.media.mediaKind === 'image') return 'Photo';
		return 'Attachment';
	}
	const text = message.text.trim();
	return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text;
}

// The quote reference embedded in a reply payload.
export function replyRefFrom(message: DisplayMessage): ReplyRef {
	return { id: message.id, from: message.from, text: replySnippet(message) };
}
