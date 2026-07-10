import { describe, expect, it } from 'vitest';
import { isUnread, previewLabel, summariesEqual, summaryFromMessage } from './conversationSummary';
import type { DisplayMessage, MediaRef } from '../types';
import type { ConversationSummary } from '../keystore';

const ME = 'alice';

function msg(partial: Partial<DisplayMessage> & Pick<DisplayMessage, 'from' | 'ts'>): DisplayMessage {
	return { id: 'm', text: '', direction: 'received', ...partial };
}

const voiceMedia: MediaRef = {
	id: 'v',
	key: 'k',
	nonce: 'n',
	digest: 'd',
	mediaKind: 'voice',
	mimeType: 'audio/webm',
	size: 10,
	durationMs: 1000,
};
const imageMedia: MediaRef = { ...voiceMedia, id: 'i', mediaKind: 'image', mimeType: 'image/png' };

describe('summaryFromMessage', () => {
	it('captures text, timestamp, and sender', () => {
		const s = summaryFromMessage(undefined, msg({ from: 'bob', text: 'hi', ts: 100 }), false);
		expect(s).toMatchObject({ lastText: 'hi', lastTs: 100, lastFrom: 'bob', lastKind: 'text', lastReadTs: 0 });
	});

	it('classifies voice vs other media, and stores no text for media', () => {
		expect(summaryFromMessage(undefined, msg({ from: 'bob', ts: 1, media: voiceMedia }), false).lastKind).toBe('voice');
		const img = summaryFromMessage(undefined, msg({ from: 'bob', ts: 1, media: imageMedia }), false);
		expect(img.lastKind).toBe('media');
		expect(img.lastText).toBe('');
	});

	it('advances lastReadTs to the message when read, preserves it otherwise', () => {
		const prev: ConversationSummary = { lastText: 'old', lastTs: 50, lastFrom: 'bob', lastKind: 'text', lastReadTs: 50 };
		expect(summaryFromMessage(prev, msg({ from: 'bob', text: 'new', ts: 100 }), true).lastReadTs).toBe(100);
		expect(summaryFromMessage(prev, msg({ from: 'bob', text: 'new', ts: 100 }), false).lastReadTs).toBe(50);
	});

	it('never regresses lastReadTs below the previous marker when read', () => {
		const prev: ConversationSummary = { lastText: 'x', lastTs: 200, lastFrom: 'bob', lastKind: 'text', lastReadTs: 200 };
		// An out-of-order older message shouldn't roll the read marker back.
		expect(summaryFromMessage(prev, msg({ from: 'bob', ts: 100 }), true).lastReadTs).toBe(200);
	});
});

describe('isUnread', () => {
	it('is true for a newer inbound message', () => {
		expect(isUnread({ lastText: 'hi', lastTs: 100, lastFrom: 'bob', lastKind: 'text', lastReadTs: 50 }, ME)).toBe(true);
	});

	it('is FALSE for our own last message, even if newer than lastRead (the key invariant)', () => {
		expect(isUnread({ lastText: 'hi', lastTs: 100, lastFrom: ME, lastKind: 'text', lastReadTs: 50 }, ME)).toBe(false);
	});

	it('is false once read up to the last message', () => {
		expect(isUnread({ lastText: 'hi', lastTs: 100, lastFrom: 'bob', lastKind: 'text', lastReadTs: 100 }, ME)).toBe(false);
	});

	it('is false when there is no summary', () => {
		expect(isUnread(undefined, ME)).toBe(false);
	});
});

describe('previewLabel', () => {
	const base = { lastTs: 1, lastReadTs: 0 };
	it('prefixes our own messages with "You: "', () => {
		expect(previewLabel({ ...base, lastText: 'hello', lastFrom: ME, lastKind: 'text' }, ME)).toBe('You: hello');
	});
	it('shows peer text plainly', () => {
		expect(previewLabel({ ...base, lastText: 'hello', lastFrom: 'bob', lastKind: 'text' }, ME)).toBe('hello');
	});
	it('labels media kinds', () => {
		expect(previewLabel({ ...base, lastText: '', lastFrom: 'bob', lastKind: 'voice' }, ME)).toBe('Voice note');
		expect(previewLabel({ ...base, lastText: '', lastFrom: ME, lastKind: 'media' }, ME)).toBe('You: Attachment');
	});

	it('never leaks the text of a retracted last message', () => {
		// The privacy bug found in verification: a tombstoned last message must
		// read "Message deleted", not its old content.
		expect(previewLabel({ ...base, lastText: 'secret', lastFrom: 'bob', lastKind: 'text', deleted: true }, ME)).toBe('Message deleted');
		expect(previewLabel({ ...base, lastText: 'secret', lastFrom: ME, lastKind: 'text', deleted: true }, ME)).toBe('You: Message deleted');
	});
});

describe('summariesEqual', () => {
	const s: ConversationSummary = { lastText: 'x', lastTs: 1, lastFrom: 'bob', lastKind: 'text', lastReadTs: 0 };
	it('is true for identical summaries', () => {
		expect(summariesEqual({ ...s }, { ...s })).toBe(true);
	});
	it('detects a changed read marker', () => {
		expect(summariesEqual(s, { ...s, lastReadTs: 1 })).toBe(false);
	});
	it('detects changed text (so a tombstone clears the preview)', () => {
		expect(summariesEqual(s, { ...s, lastText: 'different' })).toBe(false);
		expect(summariesEqual(s, { ...s, lastText: '', deleted: true })).toBe(false);
	});
	it('is false when there is no previous summary', () => {
		expect(summariesEqual(undefined, s)).toBe(false);
	});
});
