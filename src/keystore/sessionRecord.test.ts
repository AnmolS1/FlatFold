// The stored shape of a contact's sessions, and its backward compatibility.
//
// Kept pure (no IndexedDB) so the legacy-tolerance and eviction rules can be
// asserted directly rather than through a storage round trip — and so nothing
// test-only has to leak into the keystore's public surface.
import { describe, expect, it } from 'vitest';
import { capSessions, normalizeSessionRecord, type StoredSessionRecordOf } from './sessionRecord';

// The ratchet blob is opaque here — only the record shape is under test.
const ratchet = (tag: string) => ({ rootKey: tag });
const entry = (tag: string) => ({ associatedData: tag, ratchet: ratchet(tag) });

describe('normalizeSessionRecord', () => {
	it('reads a legacy single-session record as a one-session set', () => {
		// Records written before option C put the session's fields at the top
		// level, with no `sessions` array. Read tolerance keeps existing
		// conversations working across the upgrade.
		const legacy = { associatedData: 'ad', ratchet: ratchet('r') };

		expect(normalizeSessionRecord(legacy)).toEqual({ sessions: [legacy], current: 0 });
	});

	it('passes a multi-session record through unchanged', () => {
		const record: StoredSessionRecordOf<ReturnType<typeof entry>> = { sessions: [entry('a'), entry('b')], current: 1 };
		expect(normalizeSessionRecord(record)).toEqual(record);
	});

	it('clamps an out-of-range current index rather than returning undefined', () => {
		// Defensive: a truncated or hand-edited record must not make the send path
		// read `sessions[current]` as undefined.
		const record = { sessions: [entry('a')], current: 7 };
		expect(normalizeSessionRecord(record)!.current).toBe(0);
	});

	it('treats an empty session list as no record at all', () => {
		expect(normalizeSessionRecord({ sessions: [], current: 0 })).toBeNull();
	});
});

describe('capSessions', () => {
	it('keeps everything when under the cap', () => {
		const sessions = [entry('a'), entry('b')];
		expect(capSessions(sessions, 0, 3)).toEqual({ sessions, current: 0 });
	});

	it('evicts the oldest non-current session first', () => {
		// Unbounded sessions mean unbounded retained key material, which cuts
		// against forward secrecy. Oldest-first because the newest session is the
		// one a peer is most likely still sending on.
		const result = capSessions([entry('a'), entry('b'), entry('c'), entry('d')], 2, 3);

		expect(result.sessions.map((s) => s.associatedData)).toEqual(['b', 'c', 'd']);
		expect(result.sessions[result.current].associatedData).toBe('c');
	});

	it('never evicts the current session, even when it is the oldest', () => {
		const result = capSessions([entry('a'), entry('b'), entry('c'), entry('d')], 0, 2);

		expect(result.sessions.map((s) => s.associatedData)).toContain('a');
		expect(result.sessions[result.current].associatedData).toBe('a');
		expect(result.sessions).toHaveLength(2);
	});
});
