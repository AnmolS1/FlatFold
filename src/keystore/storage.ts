// Minimal promisified IndexedDB wrapper. Hand-rolled rather than pulling in
// a dependency (e.g. `idb`) — the access pattern here is a handful of
// get/put/delete calls against two flat object stores, not worth an
// abstraction layer.

const DB_NAME = 'flatfold-keystore';
// Bumped on each new object store — onupgradeneeded only fires on a version
// increase. v2 added MESSAGE_STORE; v3 added PROCESSED_STORE (idempotent
// receive, M3 Phase 2); v4 added MEDIA_CACHE_STORE (M4 attachments); v5 added
// the group stores (M5); v6 added SUMMARY_STORE (chat-list previews/unread).
const DB_VERSION = 6;

export const IDENTITY_STORE = 'identities';
export const SESSION_STORE = 'sessions';
export const MESSAGE_STORE = 'messages';
// Records the ids of inbound messages we've reached a terminal decision on
// (decrypted, or permanently failed) so a redelivery — the offline queue is
// at-least-once now that deletion is ack-gated — is recognized and skipped
// rather than replayed into the ratchet (which fails closed and would
// otherwise loop). See docs/ARCHITECTURE.md.
export const PROCESSED_STORE = 'processed';
// Decrypted attachment bytes, encrypted-at-rest with the keystore key like
// everything else — so a message's media can be re-shown after reload even
// though the R2 ciphertext was deleted on fetch-ack.
export const MEDIA_CACHE_STORE = 'mediaCache';
// Group metadata (id, name, members). Client-only — the server sees only
// opaque group ids and mailbox fan-out.
export const GROUP_STORE = 'groups';
// Our own sender key per group (mutates each send — separate store so a
// chatty group doesn't rewrite metadata every message).
export const GROUP_SENDER_STORE = 'groupSenderKeys';
// Other members' sender keys, per (group, sender).
export const GROUP_RECEIVER_STORE = 'groupReceiverKeys';
// Per-conversation summary for the chat list: last-message preview, its
// timestamp/sender, and a lastRead marker driving the unread dot. Derived from
// message history (never authoritative over it), encrypted at rest like
// everything else.
export const SUMMARY_STORE = 'conversationSummaries';

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(IDENTITY_STORE)) db.createObjectStore(IDENTITY_STORE);
			if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE);
			if (!db.objectStoreNames.contains(MESSAGE_STORE)) db.createObjectStore(MESSAGE_STORE);
			if (!db.objectStoreNames.contains(PROCESSED_STORE)) db.createObjectStore(PROCESSED_STORE);
			if (!db.objectStoreNames.contains(MEDIA_CACHE_STORE)) db.createObjectStore(MEDIA_CACHE_STORE);
			if (!db.objectStoreNames.contains(GROUP_STORE)) db.createObjectStore(GROUP_STORE);
			if (!db.objectStoreNames.contains(GROUP_SENDER_STORE)) db.createObjectStore(GROUP_SENDER_STORE);
			if (!db.objectStoreNames.contains(GROUP_RECEIVER_STORE)) db.createObjectStore(GROUP_RECEIVER_STORE);
			if (!db.objectStoreNames.contains(SUMMARY_STORE)) db.createObjectStore(SUMMARY_STORE);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function withStore<T>(storeName: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	const db = await openDb();
	try {
		return await new Promise<T>((resolve, reject) => {
			const tx = db.transaction(storeName, mode);
			const request = fn(tx.objectStore(storeName));
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	} finally {
		db.close();
	}
}

export async function getRecord<T>(storeName: string, key: string): Promise<T | undefined> {
	return withStore<T | undefined>(storeName, 'readonly', (store) => store.get(key));
}

export async function putRecord<T>(storeName: string, key: string, value: T): Promise<void> {
	await withStore(storeName, 'readwrite', (store) => store.put(value, key));
}

export async function deleteRecord(storeName: string, key: string): Promise<void> {
	await withStore(storeName, 'readwrite', (store) => store.delete(key));
}

export async function listKeys(storeName: string): Promise<string[]> {
	const keys = await withStore<IDBValidKey[]>(storeName, 'readonly', (store) => store.getAllKeys());
	return keys.map((key) => String(key));
}

// Destroys the ENTIRE keystore database — every user, every store — without
// needing (or being able to read) any key. Used by panic wipe. Best-effort:
// resolves even on error/blocked so a panic wipe never hangs.
export function deleteKeystoreDatabase(): Promise<void> {
	return new Promise((resolve) => {
		let settled = false;
		const done = () => {
			if (!settled) {
				settled = true;
				resolve();
			}
		};
		try {
			const request = indexedDB.deleteDatabase(DB_NAME);
			request.onsuccess = done;
			request.onerror = done;
			request.onblocked = done;
		} catch {
			done();
		}
	});
}
