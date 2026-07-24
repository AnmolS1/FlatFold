// Client-side block list (localStorage, per signed-in user).
//
// A blocked contact's inbound messages are ack'd (to stop resends), never
// displayed or notified, get no delivery receipt back, and are HARD-DELETED from
// local history (Chat.tsx calls keystore.deleteMessageLocal — the same purge as
// "delete for me"), so nothing is retained on-device. Their existing
// conversation is hidden from the Chats list.
//
// Honest residual: decryptIncoming has already advanced the ratchet by the time
// we can identify a sealed sender, and un-advancing it would wedge the session —
// so the message is cryptographically *received* (then purged), not refused at
// the wire. Unblocking stops dropping future messages; already-purged ones are
// gone, not restored. Pair with contact *removal* to also rotate the seal token
// (so they can't newly sealed-reach you at all).
const keyFor = (username: string) => `flatfold.blocked.${username}`;

function read(username: string): Set<string> {
	try {
		const raw = localStorage.getItem(keyFor(username));
		return new Set(raw ? (JSON.parse(raw) as string[]) : []);
	} catch {
		return new Set();
	}
}

function write(username: string, set: Set<string>): void {
	try {
		localStorage.setItem(keyFor(username), JSON.stringify([...set]));
	} catch {
		// ignore quota / serialization errors — blocking is best-effort UX
	}
}

export function isBlocked(username: string, contact: string): boolean {
	return read(username).has(contact);
}

export function getBlocked(username: string): string[] {
	return [...read(username)];
}

export function blockContact(username: string, contact: string): void {
	const set = read(username);
	set.add(contact);
	write(username, set);
}

export function unblockContact(username: string, contact: string): void {
	const set = read(username);
	set.delete(contact);
	write(username, set);
}
