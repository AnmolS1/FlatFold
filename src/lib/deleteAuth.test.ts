import { describe, expect, it } from 'vitest';
import { canDelete } from './deleteAuth';
import type { DisplayMessage } from '../types';

function msg(partial: Partial<DisplayMessage> & Pick<DisplayMessage, 'from'>): DisplayMessage {
	return { id: 'm', text: 'hi', ts: 1, direction: 'received', ...partial };
}

describe('canDelete (delete-for-everyone authorization)', () => {
	it('authorizes retracting the sender their own message', () => {
		expect(canDelete(msg({ from: 'bob' }), 'bob')).toBe(true);
	});

	it('REFUSES to let a peer delete OUR message (the core invariant)', () => {
		// bob sends a delete-control naming a message we (alice) authored.
		expect(canDelete(msg({ from: 'alice' }), 'bob')).toBe(false);
	});

	it('REFUSES to let a peer delete a third party’s message', () => {
		// In a group, mallory tries to retract carol's message.
		expect(canDelete(msg({ from: 'carol' }), 'mallory')).toBe(false);
	});

	it('is a no-op for an unknown / already-deleted target', () => {
		expect(canDelete(undefined, 'bob')).toBe(false);
	});
});
