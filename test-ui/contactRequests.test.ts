// App Review 1.2, the "filtering" requirement. The server cannot read messages
// and must never be able to, so content filtering server-side is off the table
// by design. The honest analogue for a private messenger is controlling who can
// reach you: an unknown sender's message is HELD, with no content and no
// notification, until the recipient decides.
//
// The decision is a pure function precisely so it can be table-tested. Chat.tsx
// is 1,765 lines with no test of its own — inline logic there would be
// verifiable only by mounting the whole chat surface.
import { describe, expect, it, beforeEach } from 'vitest';
import {
	gateInbound,
	isAccepted,
	acceptSender,
	declineSender,
	getPendingSenders,
	addPendingSender,
	isGroupAccepted,
	acceptGroup,
	declineGroup,
	getPendingGroups,
	addPendingGroup,
	seedAcceptedFromExisting,
	hasSeeded,
} from '../src/lib/contactRequests';

const ME = 'wren';

beforeEach(() => {
	localStorage.clear();
});

describe('inbound gate decision table', () => {
	const cases: Array<{ name: string; sender: string; setup?: () => void; expected: 'render' | 'hold' | 'drop' }> = [
		{ name: 'an accepted contact renders', sender: 'ida', setup: () => acceptSender(ME, 'ida'), expected: 'render' },
		{ name: 'an unknown sender is held', sender: 'stranger', expected: 'hold' },
		{ name: 'a blocked sender is dropped', sender: 'pest', setup: () => declineSender(ME, 'pest'), expected: 'drop' },
		{
			name: 'blocked beats accepted — blocking someone you accepted still drops',
			sender: 'ida',
			setup: () => {
				acceptSender(ME, 'ida');
				declineSender(ME, 'ida');
			},
			expected: 'drop',
		},
		{ name: 'a message from yourself always renders', sender: ME, expected: 'render' },
	];

	for (const c of cases) {
		it(c.name, () => {
			c.setup?.();
			expect(gateInbound(ME, c.sender)).toBe(c.expected);
		});
	}
});

describe('accepting and declining', () => {
	it('holding a sender puts them in the pending list without accepting them', () => {
		addPendingSender(ME, 'stranger');
		expect(getPendingSenders(ME)).toEqual(['stranger']);
		expect(isAccepted(ME, 'stranger')).toBe(false);
		expect(gateInbound(ME, 'stranger')).toBe('hold');
	});

	it('accepting clears the request and lets the sender through', () => {
		addPendingSender(ME, 'stranger');
		acceptSender(ME, 'stranger');
		expect(getPendingSenders(ME)).toEqual([]);
		expect(gateInbound(ME, 'stranger')).toBe('render');
	});

	it('declining clears the request and blocks them', () => {
		addPendingSender(ME, 'pest');
		declineSender(ME, 'pest');
		expect(getPendingSenders(ME)).toEqual([]);
		// Declining must be indistinguishable from being ignored, and must stop
		// the next message too — otherwise "decline" is just "dismiss".
		expect(gateInbound(ME, 'pest')).toBe('drop');
	});

	it('does not list the same pending sender twice', () => {
		addPendingSender(ME, 'stranger');
		addPendingSender(ME, 'stranger');
		expect(getPendingSenders(ME)).toEqual(['stranger']);
	});

	it('keeps request state per signed-in user', () => {
		acceptSender(ME, 'ida');
		expect(gateInbound('someone_else', 'ida')).toBe('hold');
	});
});

describe('group invites', () => {
	it('a group from an unknown creator is held', () => {
		addPendingGroup(ME, 'g1', 'stranger');
		expect(isGroupAccepted(ME, 'g1')).toBe(false);
		expect(getPendingGroups(ME)).toEqual([{ groupId: 'g1', creator: 'stranger' }]);
	});

	it('accepting a group lets it render', () => {
		addPendingGroup(ME, 'g1', 'stranger');
		acceptGroup(ME, 'g1');
		expect(isGroupAccepted(ME, 'g1')).toBe(true);
		expect(getPendingGroups(ME)).toEqual([]);
	});

	it('declining a group clears it and blocks the creator', () => {
		addPendingGroup(ME, 'g1', 'pest');
		declineGroup(ME, 'g1');
		expect(getPendingGroups(ME)).toEqual([]);
		expect(isGroupAccepted(ME, 'g1')).toBe(false);
		// The creator is the one who reached you — blocking them is what stops a
		// second invite arriving straight after.
		expect(gateInbound(ME, 'pest')).toBe('drop');
	});
});

describe('seeding on upgrade', () => {
	it('accepts every pre-existing contact and group, so upgrading gates nobody', () => {
		seedAcceptedFromExisting(ME, ['ida', 'leo'], ['g1']);
		expect(gateInbound(ME, 'ida')).toBe('render');
		expect(gateInbound(ME, 'leo')).toBe('render');
		expect(isGroupAccepted(ME, 'g1')).toBe(true);
		expect(hasSeeded(ME)).toBe(true);
	});

	it('runs once — a later seed cannot re-accept someone who was declined', () => {
		seedAcceptedFromExisting(ME, ['ida'], []);
		declineSender(ME, 'ida');
		// decryptIncoming auto-adds unknown senders as keystore contacts, so a
		// blocked person is STILL in the contact list. Re-seeding from it would
		// silently unblock them.
		seedAcceptedFromExisting(ME, ['ida'], []);
		expect(gateInbound(ME, 'ida')).toBe('drop');
	});

	it('reports not-yet-seeded before the first seed', () => {
		expect(hasSeeded(ME)).toBe(false);
	});
});
