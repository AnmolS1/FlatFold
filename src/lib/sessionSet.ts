// A contact's ratchet sessions, and how a collision between them resolves.
//
// Normally a contact has exactly one session. But two people can end up with
// two: if both send before either receives (glare), each builds its own
// initiator session from its own X3DH run, and those have different shared
// secrets — so neither can read the other's messages. Option A makes that rare
// (sessions are only created on the first send, not at contact-add time); this
// module makes it survivable.
//
// Holding both sessions is already enough for DELIVERY: A→B rides A's session
// and B→A rides B's, with each side trial-decrypting the other's. What the
// tie-break adds is CONVERGENCE onto one bidirectional session — which matters
// for forward secrecy, not tidiness: a chain nobody ever replies on never takes
// a DH ratchet step, so it keeps advancing its symmetric KDF without ever
// re-keying from a fresh DH.
//
// See docs/SESSION_COLLISION_OPTIONS.md.

import { tryRatchetDecrypt } from '../crypto/doubleRatchet';
import type { RatchetState } from '../crypto';

export interface SessionEntry {
	ratchet: RatchetState;
	associatedData: Uint8Array;
}

/**
 * Which of two users plays initiator when both tried to start a session at
 * once. The lower username wins; the loser adopts a responder session built
 * from the winner's handshake, and both end up on the winner's chain.
 *
 * Keyed off usernames rather than identity keys because usernames are stable
 * across key rotation — an identity-key tie-break could flip the winner
 * mid-conversation at exactly the moment a key change is already being handled.
 *
 * The ordering is total and both sides always agree: usernames are
 * `[a-zA-Z0-9_]{3,32}`, stored as a `TEXT PRIMARY KEY` under SQLite's BINARY
 * collation and looked up by exact match, so a client can never hold a
 * non-canonical spelling of a peer's name. Raw code-unit comparison only —
 * `localeCompare` would disagree across locales.
 */
export function isDesignatedInitiator(me: string, peer: string): boolean {
	return me < peer;
}

/**
 * Try to decrypt a message against each of a contact's sessions, in order.
 *
 * Returns the matching session's index and the plaintext, or `null` when none
 * of them can read it ("not any session we hold" — for an x3dh-bearing frame
 * that's the cue to build a responder session).
 *
 * A decryption failure AFTER a header match is NOT swallowed. `tryRatchetDecrypt`
 * returns `null` for "wrong session, keep looking" but throws when the header
 * matched and the message AEAD failed — that means this IS the session and the
 * message is corrupt or tampered, so it must fail closed. Catching it here and
 * falling through would silently retry a tampered message against every other
 * session. Only a `null` advances the loop.
 *
 * Non-matching sessions are left unmutated (tryRatchetDecrypt is transactional);
 * the matching one has its ratchet advance committed, so the caller must persist
 * the session at `index`.
 */
export function trialDecryptSessions(
	sessions: readonly SessionEntry[],
	encryptedHeader: Uint8Array,
	ciphertext: Uint8Array
): { index: number; plaintext: Uint8Array } | null {
	for (let index = 0; index < sessions.length; index++) {
		const session = sessions[index];
		const plaintext = tryRatchetDecrypt(session.ratchet, encryptedHeader, ciphertext, session.associatedData);
		if (plaintext !== null) return { index, plaintext };
	}
	return null;
}

/**
 * Which session to send on after adopting a newly-built responder session.
 *
 * The designated initiator keeps its own session (the peer will adopt ours);
 * everyone else yields to the session they just read the peer on. Applying this
 * on both sides lands them on the same bidirectional chain.
 */
export function currentAfterAdopting(me: string, peer: string, currentIndex: number, adoptedIndex: number): number {
	return isDesignatedInitiator(me, peer) ? currentIndex : adoptedIndex;
}
