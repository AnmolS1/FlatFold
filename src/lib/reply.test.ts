import { describe, expect, it } from 'vitest';
import { replyRefFrom, replySnippet } from './reply';
import type { DisplayMessage, MediaRef } from '../types';

function msg(partial: Partial<DisplayMessage>): DisplayMessage {
	return { id: 'm1', from: 'bob', text: '', ts: 1, direction: 'received', ...partial };
}

const media = (mediaKind: MediaRef['mediaKind']): MediaRef => ({
	id: 'x',
	key: 'k',
	nonce: 'n',
	digest: 'd',
	mediaKind,
	mimeType: 'application/octet-stream',
	size: 1,
});

describe('replySnippet', () => {
	it('returns trimmed text for a text message', () => {
		expect(replySnippet(msg({ text: '  hello there  ' }))).toBe('hello there');
	});

	it('truncates long text with an ellipsis', () => {
		const long = 'a'.repeat(200);
		const snip = replySnippet(msg({ text: long }));
		expect(snip.endsWith('…')).toBe(true);
		expect(snip.length).toBe(121); // 120 chars + ellipsis
	});

	it('labels media kinds instead of leaking bytes', () => {
		expect(replySnippet(msg({ media: media('voice') }))).toBe('Voice note');
		expect(replySnippet(msg({ media: media('image') }))).toBe('Photo');
		expect(replySnippet(msg({ media: media('file') }))).toBe('Attachment');
	});

	it('renders a tombstone as a neutral note', () => {
		expect(replySnippet(msg({ text: 'secret', deleted: true }))).toBe('Deleted message');
	});
});

describe('replyRefFrom', () => {
	it('captures id, sender, and snippet', () => {
		expect(replyRefFrom(msg({ id: 'abc', from: 'carol', text: 'hi' }))).toEqual({ id: 'abc', from: 'carol', text: 'hi' });
	});
});
