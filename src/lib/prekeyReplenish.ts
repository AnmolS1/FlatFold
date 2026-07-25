// Keeps this account's one-time prekey pool from running dry.
//
// X3DH mixes a one-time prekey into the initial handshake, and the server
// deletes each one as it is claimed. The pool was generated once, at identity
// creation (20 keys), and nothing ever refilled it — so after twenty first
// contacts, which is ordinary use rather than an attack, the pool was empty
// permanently and every later contact silently fell back to no-OTP X3DH, which
// weakens first-message forward secrecy. See FULL_AUDIT §2.
//
// The fix is replenishment, not the "last-resort prekey" the audit suggested: a
// reusable prekey is shared across initiators and never deleted, which leaves it
// in the same forward-secrecy position as having no one-time prekey at all.
//
// Ordering is load-bearing. keystore.addOneTimePreKeys persists the secrets
// before it returns, and only then do we publish the public halves. Publishing
// first would risk handing out keys whose secrets we never stored, which would
// wedge first contact for whoever claimed one.
import { apiAddOneTimePreKeys, apiGetPreKeyCount } from './api';
import * as keystore from '../keystore';

// Refill when at or below this. Chosen so a burst of new contacts can't drain
// the pool between one app start and the next.
const LOW_WATER_MARK = 8;
// Refill target. Matches the initial batch, and stays well under the server's
// stored ceiling (100) so a top-up is never clamped in normal use.
const TARGET_POOL = 20;

// Don't re-ask the server on every chat mount. The pool only drains on the
// authenticated-fallback path, so it moves slowly, and a stale reading is
// harmless (the next check catches it). Module-scoped on purpose: a page reload
// re-checks, which is the cadence we actually want.
const RECHECK_AFTER_MS = 30 * 60 * 1000;
let lastCheckedAt = 0;

let inFlight: Promise<void> | null = null;

/**
 * Tops the pool back up if it has run low. Best-effort and safe to call on every
 * app start: it is a single cheap GET when the pool is healthy, it de-dupes
 * concurrent callers, and any failure is swallowed (the next start retries).
 */
export async function replenishPreKeysIfLow(username: string): Promise<void> {
	if (inFlight) return inFlight;
	if (Date.now() - lastCheckedAt < RECHECK_AFTER_MS) return;
	inFlight = (async () => {
		try {
			const remaining = await apiGetPreKeyCount();
			lastCheckedAt = Date.now(); // only after a SUCCESSFUL read, so an
			// offline attempt doesn't start a quiet 30-minute blackout.
			if (remaining > LOW_WATER_MARK) return;

			const shortfall = TARGET_POOL - remaining;
			if (shortfall <= 0) return;

			// Secrets land in the encrypted local doc first; only then do the
			// public halves go to the server.
			const publicKeys = await keystore.addOneTimePreKeys(username, shortfall);
			if (publicKeys.length > 0) await apiAddOneTimePreKeys(publicKeys);
		} catch {
			// Offline, locked, or a transient server error. The pool is only ever
			// short, never wrong, so retrying on the next start is enough.
		} finally {
			inFlight = null;
		}
	})();
	return inFlight;
}

/** Test seam: forget the de-dupe and recheck-cooldown state between cases. */
export function __resetReplenishStateForTests(): void {
	inFlight = null;
	lastCheckedAt = 0;
}
