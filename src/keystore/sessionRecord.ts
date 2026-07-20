// The stored shape of a contact's ratchet sessions.
//
// A contact normally has exactly one session, but can hold several after a
// glare — both sides sending before either receives, so each builds its own
// initiator session. Holding both is what stops a message being lost; see
// src/lib/sessionSet.ts and docs/SESSION_COLLISION_OPTIONS.md.
//
// Kept in its own module, free of IndexedDB, so the compatibility and eviction
// rules are directly testable.

// Generic over the entry type: this module cares only about the record's
// SHAPE, never the ratchet blob inside it, so the keystore keeps its own
// concrete session type rather than widening it to `unknown` here.
export interface StoredSessionRecordOf<E> {
	sessions: E[];
	/** Index of the session outgoing messages are encrypted on. */
	current: number;
}

/** What's actually on disk: either shape, depending on when it was written. */
export type StoredSessionBlobOf<E> = StoredSessionRecordOf<E> | E;

/**
 * Read either stored shape as a session set.
 *
 * Records written before multi-session support have the session's fields at the
 * top level with no `sessions` array; they read as a one-session set so
 * existing conversations survive the upgrade. The next write reshapes them.
 *
 * Returns null for a record with no usable session, so callers can treat it the
 * same as "no record".
 */
export function normalizeSessionRecord<E>(blob: StoredSessionBlobOf<E>): StoredSessionRecordOf<E> | null {
	if (!blob || typeof blob !== 'object' || !('sessions' in blob)) return { sessions: [blob as E], current: 0 };
	if (blob.sessions.length === 0) return null;

	// Clamp rather than trust: a truncated or hand-edited record must never make
	// the send path read `sessions[current]` as undefined.
	const current = Number.isInteger(blob.current) && blob.current >= 0 && blob.current < blob.sessions.length ? blob.current : 0;
	return { sessions: blob.sessions, current };
}

/** How many sessions a single contact may retain. */
export const MAX_SESSIONS_PER_CONTACT = 3;

/**
 * Drop the oldest sessions until at most `cap` remain.
 *
 * Unbounded sessions would mean unbounded retained key material, which cuts
 * against the forward-secrecy story — a retained session is a decryption
 * capability that outlives its usefulness. Oldest-first, because the newest
 * session is the one a peer is most likely still sending on. The current
 * session is never evicted, even when it is the oldest.
 */
export function capSessions<E>(sessions: E[], current: number, cap: number = MAX_SESSIONS_PER_CONTACT): StoredSessionRecordOf<E> {
	if (sessions.length <= cap) return { sessions, current };

	const keep = sessions.slice(sessions.length - cap);
	const currentSession = sessions[current];
	if (!keep.includes(currentSession)) {
		// The current session fell outside the window — evict the oldest kept one
		// to make room for it rather than losing the session we send on.
		keep[0] = currentSession;
	}
	return { sessions: keep, current: keep.indexOf(currentSession) };
}
