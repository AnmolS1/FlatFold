// The unknown-sender gate (App Review 1.2, "a method for filtering objectionable
// content").
//
// WHY THIS SHAPE. Apple asks for content filtering. FlatFold's server cannot read
// messages and must never be able to, so scanning is not on the table and
// pretending otherwise would be a lie in the review notes. The honest analogue
// for a private messenger — and what every other E2EE messenger on the store does
// — is to control who can REACH you: a message from someone who is not already a
// contact is held with NO content, NO media preview and NO notification until you
// decide. Unsolicited objectionable content is therefore never displayed
// unprompted, which is the property Apple is actually asking for, and it needs no
// server-side visibility at all.
//
// WHY localStorage AND NOT THE KEYSTORE. `src/keystore/**` is frozen. This
// mirrors `blocklist.ts` exactly — same storage, same per-user key shape, same
// best-effort error handling — because it is the same kind of state: a local
// policy decision about other people, not key material.
//
// HONEST RESIDUALS, both inherited rather than introduced:
//  - `decryptIncoming` has already advanced the ratchet by the time the sender is
//    known, and un-advancing it would wedge the session. A held message is
//    therefore cryptographically RECEIVED, just never surfaced. This is the same
//    residual `blocklist.ts` documents, and it is why holding (rather than
//    refusing at the wire) is the only option that does not break the ratchet.
//  - Because `decryptIncoming` also auto-adds an unknown sender as a keystore
//    contact, a pending stranger IS in the contact list. That is why the seed
//    below runs exactly once: re-seeding from the contact list would promote
//    people you had already declined back to accepted. Callers must filter the
//    contact list through `isAccepted` before rendering it anywhere.
import { blockContact, isBlocked } from './blocklist';

const acceptedKey = (username: string) => `flatfold.accepted.${username}`;
const pendingKey = (username: string) => `flatfold.pending.${username}`;
const acceptedGroupsKey = (username: string) => `flatfold.acceptedGroups.${username}`;
const pendingGroupsKey = (username: string) => `flatfold.pendingGroups.${username}`;
const seededKey = (username: string) => `flatfold.requestsSeeded.${username}`;

function readList<T>(key: string): T[] {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T[]) : [];
	} catch {
		return [];
	}
}

function writeList<T>(key: string, values: T[]): void {
	try {
		localStorage.setItem(key, JSON.stringify(values));
	} catch {
		// Quota / serialization failures are non-fatal: the gate then holds a
		// sender it has already held, which is the safe direction to fail.
	}
}

/** What to do with an inbound message, once the ratchet has named its sender. */
export type InboundGate = 'render' | 'hold' | 'drop';

/**
 * The whole decision, in one place.
 *
 * Order matters: `drop` is checked before `render` so that blocking someone you
 * had previously accepted actually stops them — the reverse order would let a
 * stale acceptance outrank a live block.
 */
export function gateInbound(currentUsername: string, sender: string): InboundGate {
	if (sender === currentUsername) return 'render';
	if (isBlocked(currentUsername, sender)) return 'drop';
	if (isAccepted(currentUsername, sender)) return 'render';
	return 'hold';
}

export function isAccepted(currentUsername: string, sender: string): boolean {
	return readList<string>(acceptedKey(currentUsername)).includes(sender);
}

export function getPendingSenders(currentUsername: string): string[] {
	return readList<string>(pendingKey(currentUsername));
}

export function addPendingSender(currentUsername: string, sender: string): void {
	const pending = readList<string>(pendingKey(currentUsername));
	if (pending.includes(sender)) return;
	writeList(pendingKey(currentUsername), [...pending, sender]);
}

export function acceptSender(currentUsername: string, sender: string): void {
	const accepted = readList<string>(acceptedKey(currentUsername));
	if (!accepted.includes(sender)) writeList(acceptedKey(currentUsername), [...accepted, sender]);
	clearPendingSender(currentUsername, sender);
}

/**
 * Decline: drop the request AND block the sender, silently. The sender is told
 * nothing — a decline that notified them would turn "no" into an invitation to
 * try again from a new account, and would confirm the account exists.
 */
export function declineSender(currentUsername: string, sender: string): void {
	clearPendingSender(currentUsername, sender);
	// Also revoke any prior acceptance, so `gateInbound` can't be talked into
	// 'render' if the block is ever lifted without an explicit re-accept.
	writeList(
		acceptedKey(currentUsername),
		readList<string>(acceptedKey(currentUsername)).filter((u) => u !== sender)
	);
	blockContact(currentUsername, sender);
}

function clearPendingSender(currentUsername: string, sender: string): void {
	writeList(
		pendingKey(currentUsername),
		readList<string>(pendingKey(currentUsername)).filter((u) => u !== sender)
	);
}

// ---- group invites ----
// A group is gated on its CREATOR, because `messaging.ts` lets any user bootstrap
// a group naming themselves creator and listing you as a member (only the claimed
// creator may invite you, but anyone may claim to be a creator). Without this, a
// stranger could push group content that renders immediately and the 1:1 gate
// would be cosmetic against the very vector it is meant to close.

export interface PendingGroup {
	groupId: string;
	creator: string;
}

export function isGroupAccepted(currentUsername: string, groupId: string): boolean {
	return readList<string>(acceptedGroupsKey(currentUsername)).includes(groupId);
}

export function getPendingGroups(currentUsername: string): PendingGroup[] {
	return readList<PendingGroup>(pendingGroupsKey(currentUsername));
}

export function addPendingGroup(currentUsername: string, groupId: string, creator: string): void {
	const pending = readList<PendingGroup>(pendingGroupsKey(currentUsername));
	if (pending.some((g) => g.groupId === groupId)) return;
	writeList(pendingGroupsKey(currentUsername), [...pending, { groupId, creator }]);
}

export function acceptGroup(currentUsername: string, groupId: string): void {
	const accepted = readList<string>(acceptedGroupsKey(currentUsername));
	if (!accepted.includes(groupId)) writeList(acceptedGroupsKey(currentUsername), [...accepted, groupId]);
	clearPendingGroup(currentUsername, groupId);
}

/** Declining a group also blocks whoever invited you — see `declineSender`. */
export function declineGroup(currentUsername: string, groupId: string): void {
	const creator = getPendingGroups(currentUsername).find((g) => g.groupId === groupId)?.creator;
	clearPendingGroup(currentUsername, groupId);
	writeList(
		acceptedGroupsKey(currentUsername),
		readList<string>(acceptedGroupsKey(currentUsername)).filter((id) => id !== groupId)
	);
	if (creator) declineSender(currentUsername, creator);
}

function clearPendingGroup(currentUsername: string, groupId: string): void {
	writeList(
		pendingGroupsKey(currentUsername),
		readList<PendingGroup>(pendingGroupsKey(currentUsername)).filter((g) => g.groupId !== groupId)
	);
}

// ---- upgrade seeding ----

export function hasSeeded(currentUsername: string): boolean {
	try {
		return localStorage.getItem(seededKey(currentUsername)) !== null;
	} catch {
		return false;
	}
}

/**
 * One-time migration for accounts that predate the gate: everyone you were
 * already talking to stays a normal conversation.
 *
 * Runs exactly ONCE per account, and that is load-bearing rather than an
 * optimisation. `decryptIncoming` auto-adds unknown senders as keystore
 * contacts, so someone you declined is still in the contact list — a second
 * seed would read them back out and silently un-decline them.
 *
 * CALLERS: only seed after the contact list has actually loaded. Seeding an
 * empty list because a fetch had not resolved yet would set the flag and gate
 * every existing conversation, with no way to re-run.
 */
export function seedAcceptedFromExisting(currentUsername: string, contacts: string[], groupIds: string[]): void {
	if (hasSeeded(currentUsername)) return;
	const accepted = new Set(readList<string>(acceptedKey(currentUsername)));
	for (const contact of contacts) accepted.add(contact);
	writeList(acceptedKey(currentUsername), [...accepted]);

	const acceptedGroups = new Set(readList<string>(acceptedGroupsKey(currentUsername)));
	for (const id of groupIds) acceptedGroups.add(id);
	writeList(acceptedGroupsKey(currentUsername), [...acceptedGroups]);

	try {
		localStorage.setItem(seededKey(currentUsername), '1');
	} catch {
		// If the flag can't be written the seed re-runs next load, which is
		// harmless on a first upgrade and is caught by the decline check above.
	}
}
