// Panic wipe — destroy everything recoverable on this device, fast and
// irreversibly. The ordering constraint (per design review): it MUST work
// while the keystore is locked AND while offline. So every step of local
// destruction is key-independent (nothing here decrypts anything) and
// network-independent; the server logout is best-effort and never blocks the
// wipe.

import { deleteKeystoreDatabase, lockAll } from '../keystore';

// A window event any control (settings button, unlock-screen link) can
// dispatch to open the panic-wipe confirmation, so the confirmation dialog
// can live at one always-mounted place (above the keystore-unlock gate)
// while triggers live wherever they're needed.
export const PANIC_EVENT = 'flatfold:panic';

export function requestPanicWipe(): void {
	window.dispatchEvent(new Event(PANIC_EVENT));
}

export async function panicWipe(bestEffortLogout: () => Promise<void>): Promise<void> {
	// 1. Local, unconditional destruction — no key, no network needed.

	// In-memory keystore keys first — gone immediately, not just after the
	// post-wipe reload.
	lockAll();

	// The whole encrypted keystore DB (all identities, sessions, message
	// history, processed ids, one-time-prekey secrets).
	await deleteKeystoreDatabase();

	// Any cached keystore preferences + storage (the key itself is no longer in
	// sessionStorage as of M7, but clear both stores regardless).
	try {
		sessionStorage.clear();
	} catch {
		/* ignore */
	}
	try {
		localStorage.clear();
	} catch {
		/* ignore */
	}

	// Service-worker caches (app-shell etc). The Cache API exists independently
	// of whether a service worker is registered yet (SW lands in M6).
	try {
		if ('caches' in globalThis) {
			const names = await caches.keys();
			await Promise.all(names.map((name) => caches.delete(name)));
		}
	} catch {
		/* ignore */
	}

	// Unregister any service workers so a cached app shell can't be served
	// again post-wipe.
	try {
		if ('serviceWorker' in navigator) {
			const registrations = await navigator.serviceWorker.getRegistrations();
			await Promise.all(registrations.map((r) => r.unregister()));
		}
	} catch {
		/* ignore */
	}

	// 2. Best-effort server logout — clears the session cookie. Fire it, but
	// don't await or fail the wipe on it: someone hitting panic while offline
	// still gets a fully-wiped local device.
	void bestEffortLogout().catch(() => {});
}
