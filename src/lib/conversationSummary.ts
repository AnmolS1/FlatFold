// Pure helpers for the chat-list preview/unread cache. Kept dependency-free
// (types only) so the unread invariant and preview formatting can be unit
// tested without IndexedDB or React. Both the derivation effect in Chat and the
// row rendering in ContactList go through these, so there is one source of
// truth for "what does this conversation's last message look like / is it
// unread".

import type { DisplayMessage } from '../types';
import type { ConversationSummary } from '../keystore';

// Builds a conversation summary from its latest message. `read` (the
// conversation is currently open) advances the lastRead marker to this message,
// which is what clears the unread dot; otherwise the prior marker is preserved.
export function summaryFromMessage(
	prev: ConversationSummary | undefined,
	message: DisplayMessage,
	read: boolean
): ConversationSummary {
	const lastReadTs = read ? Math.max(prev?.lastReadTs ?? 0, message.ts) : prev?.lastReadTs ?? 0;
	return {
		lastText: message.media ? '' : message.text,
		lastTs: message.ts,
		lastFrom: message.from,
		lastKind: message.media ? (message.media.mediaKind === 'voice' ? 'voice' : 'media') : 'text',
		lastReadTs,
		deleted: message.deleted,
	};
}

// True when there's a newer inbound message than the user has seen. Crucially,
// a message WE sent is never unread — only `lastFrom !== me` counts — so
// echoing our own send never lights the dot.
export function isUnread(summary: ConversationSummary | undefined, me: string): boolean {
	return !!summary && summary.lastFrom !== me && summary.lastTs > summary.lastReadTs;
}

// Whether two summaries are display-equivalent — lets the derivation effect
// skip a state write (and a re-render) when nothing changed.
export function summariesEqual(a: ConversationSummary | undefined, b: ConversationSummary): boolean {
	return (
		!!a &&
		a.lastTs === b.lastTs &&
		a.lastFrom === b.lastFrom &&
		a.lastKind === b.lastKind &&
		a.lastReadTs === b.lastReadTs &&
		a.lastText === b.lastText &&
		!!a.deleted === !!b.deleted
	);
}

// The one-line preview text for a summary: a media label or the message text,
// prefixed with "You: " when we were the last sender.
export function previewLabel(summary: ConversationSummary, me: string): string {
	const mine = summary.lastFrom === me ? 'You: ' : '';
	// A retracted last message must never surface its old text in the list.
	if (summary.deleted) return `${mine}Message deleted`;
	if (summary.lastKind === 'voice') return `${mine}Voice note`;
	if (summary.lastKind === 'media') return `${mine}Attachment`;
	return `${mine}${summary.lastText}`.trim();
}
