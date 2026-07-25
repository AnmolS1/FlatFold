// Public API of the encrypted local keystore. Everything this module
// persists (identity keys, one-time prekey secrets, contacts, ratchet
// session state) lives in IndexedDB as AEAD ciphertext, keyed by a
// password-derived key that never leaves the device and is never sent to
// the server.
//
// Unlock is a separate step from server login. AuthContext's session
// bootstrap (GET /api/auth/me) restores *who's logged in* from an httpOnly
// cookie on every fresh load — but the password itself is never retained
// in JS memory past the login/signup call, so there's nothing to unlock the
// keystore from on a plain reload — the user re-enters their password.
//
// Encryption model (D7): a random 32-byte MASTER KEY (MK) encrypts every store.
// MK is itself AEAD-wrapped in the identity record under a password-derived key
// (see ./identityRecord + ./crypto). Unlock derives that wrapping key, unwraps
// MK, and caches MK in-memory (a module-scoped Map — NOT sessionStorage; see the
// unlock-key cache below). So a credential change (change-password / recovery)
// is a cheap re-wrap of MK rather than re-encrypting every store. Legacy records
// that predate MK (the password-derived key encrypted blobs directly) migrate on
// their next unlock by adopting that key as MK — an atomic single-record rewrite,
// no store re-encryption.
//
// New-device / cleared-storage handling: if `unlock()` finds no local
// identity for a username that just authenticated successfully, the
// caller (AuthContext) generates and publishes a *fresh* identity — losing
// access to prior conversations from this device, and changing this
// user's safety number for every contact (the non-dismissable warning
// contacts see on that change is a later milestone's UI; the key rotation
// itself is honest and correct today). This matches the spec's single-
// device-v1 stance: no key escrow, no cross-device backup.

import {
	generateIdentityKeyPair,
	generateOneTimePreKeys,
	generateSignedPreKey,
	type IdentityKeyPair,
	type IdentityPublicKeys,
	type OneTimePreKey,
	type RatchetState,
	type SignedPreKey,
} from '../crypto';
import { base64ToBytes, bytesToBase64 } from './codec';
import { decryptBlob, encryptBlob, generateMasterKey, type EncryptedBlob } from './crypto';
import {
	sealIdentityRecord,
	openIdentityRecord,
	stageRewrap,
	promoteRewrap,
	abortRewrap,
	WrongPasswordError,
	type IdentityRecordV2,
	type StoredIdentityRecord,
} from './identityRecord';
import { buildRecoveryEnrollment, generateRecoveryCode, openRecoveryBlob, type RecoveryEnrollment } from './recovery';
import { biometricDeleteSecret, biometricGetSecret, biometricHasSecret, biometricSetSecret } from '../lib/biometric';
import type { DisplayMessage } from '../types';
import {
	deleteKeystoreDatabase,
	deleteRecord,
	getRecord,
	GROUP_RECEIVER_STORE,
	GROUP_SENDER_STORE,
	GROUP_STORE,
	IDENTITY_STORE,
	listKeys,
	MEDIA_CACHE_STORE,
	MESSAGE_STORE,
	PROCESSED_STORE,
	putRecord,
	SESSION_STORE,
	SUMMARY_STORE,
} from './storage';
import type { ReceiverSenderKeyState, SenderKeyState } from '../crypto';
import { capSessions, normalizeSessionRecord, type StoredSessionBlobOf, type StoredSessionRecordOf } from './sessionRecord';

export { deleteKeystoreDatabase };

// ---- serialized shapes persisted (encrypted) in IndexedDB ----

interface StoredIdentityDoc {
	identity: {
		signingPublicKey: string;
		signingSecretKey: string;
		dhPublicKey: string;
		dhSecretKey: string;
	};
	signedPreKey: {
		publicKey: string;
		secretKey: string;
		signature: string;
	};
	// publicKey (base64) -> secretKey (base64); removed once consumed
	// responding to a first message that used it.
	oneTimePreKeys: Record<string, string>;
	contacts: Record<string, StoredContact>;
	// Sealed sender: MY current delivery token — the one I register with my own
	// mailbox DO and publish in my bundle so others can reach me on the
	// sender-hidden path. Rotated when I remove a contact. Absent until I first
	// publish keys with sealed sender enabled.
	sealToken?: string;
}

interface StoredContact {
	signingPublicKey: string;
	dhPublicKey: string;
	// True once the user has confirmed this contact's safety number
	// out-of-band (compared digits, or scanned their QR). Reset to false on
	// any identity-key change.
	verified?: boolean;
	// True when this contact's identity key changed and the user hasn't yet
	// acknowledged the warning. Drives the non-dismissable banner.
	keyChangeUnacknowledged?: boolean;
	// Disappearing-messages timer for this conversation, in seconds (0 = off).
	// Synced across both sides by an in-channel 'timer' control message.
	disappearingSeconds?: number;
	// Sealed sender: THIS contact's current delivery token, learned over our
	// authenticated ratchet (a 'deliverytoken' payload) or their bundle, so I
	// can send to them on the sealed path. Lives on the contact so removing the
	// contact drops it automatically.
	sealToken?: string;
}

interface StoredSkippedKey {
	headerKey: string;
	messageKey: string;
	messageNumber: number;
}

interface StoredRatchetState {
	rootKey: string;
	dhSelfPublicKey: string;
	dhSelfSecretKey: string;
	dhRemotePublicKey: string | null;
	sendingChainKey: string | null;
	receivingChainKey: string | null;
	sendHeaderKey: string | null;
	receiveHeaderKey: string | null;
	nextSendHeaderKey: string | null;
	nextReceiveHeaderKey: string | null;
	sendMessageNumber: number;
	receiveMessageNumber: number;
	previousSendingChainLength: number;
	skippedMessageKeys: [string, StoredSkippedKey][];
}

interface StoredSession {
	associatedData: string;
	ratchet: StoredRatchetState;
}

// A contact's sessions are a SET (usually of one). See ./sessionRecord.
type StoredSessionRecord = StoredSessionRecordOf<StoredSession>;
type StoredSessionBlob = StoredSessionBlobOf<StoredSession>;

function serializeRatchetState(state: RatchetState): StoredRatchetState {
	const b64 = (v: Uint8Array | null) => (v ? bytesToBase64(v) : null);
	return {
		rootKey: bytesToBase64(state.rootKey),
		dhSelfPublicKey: bytesToBase64(state.dhSelf.publicKey),
		dhSelfSecretKey: bytesToBase64(state.dhSelf.secretKey),
		dhRemotePublicKey: b64(state.dhRemotePublicKey),
		sendingChainKey: b64(state.sendingChainKey),
		receivingChainKey: b64(state.receivingChainKey),
		sendHeaderKey: b64(state.sendHeaderKey),
		receiveHeaderKey: b64(state.receiveHeaderKey),
		nextSendHeaderKey: b64(state.nextSendHeaderKey),
		nextReceiveHeaderKey: b64(state.nextReceiveHeaderKey),
		sendMessageNumber: state.sendMessageNumber,
		receiveMessageNumber: state.receiveMessageNumber,
		previousSendingChainLength: state.previousSendingChainLength,
		skippedMessageKeys: Array.from(state.skippedMessageKeys.entries()).map(([k, v]) => [
			k,
			{ headerKey: bytesToBase64(v.headerKey), messageKey: bytesToBase64(v.messageKey), messageNumber: v.messageNumber },
		]),
	};
}

function deserializeRatchetState(stored: StoredRatchetState): RatchetState {
	const bytes = (v: string | null) => (v ? base64ToBytes(v) : null);
	return {
		rootKey: base64ToBytes(stored.rootKey),
		dhSelf: { publicKey: base64ToBytes(stored.dhSelfPublicKey), secretKey: base64ToBytes(stored.dhSelfSecretKey) },
		dhRemotePublicKey: bytes(stored.dhRemotePublicKey),
		sendingChainKey: bytes(stored.sendingChainKey),
		receivingChainKey: bytes(stored.receivingChainKey),
		sendHeaderKey: bytes(stored.sendHeaderKey),
		receiveHeaderKey: bytes(stored.receiveHeaderKey),
		nextSendHeaderKey: bytes(stored.nextSendHeaderKey),
		nextReceiveHeaderKey: bytes(stored.nextReceiveHeaderKey),
		sendMessageNumber: stored.sendMessageNumber,
		receiveMessageNumber: stored.receiveMessageNumber,
		previousSendingChainLength: stored.previousSendingChainLength,
		skippedMessageKeys: new Map(
			stored.skippedMessageKeys.map(([k, v]) => [
				k,
				{ headerKey: base64ToBytes(v.headerKey), messageKey: base64ToBytes(v.messageKey), messageNumber: v.messageNumber },
			])
		),
	};
}

// ---- in-memory unlock-key cache (M7 hardening) ----
// The Argon2id-derived keystore key is held ONLY here, in a module-scoped map
// in the JS heap — never in `sessionStorage` (which is script-readable via the
// storage API and persists in devtools/extensions). Consequences:
//   • The key is gone on page reload / new tab → the user re-unlocks (re-enters
//     their password) each time. This is the deliberate security/UX tradeoff.
//   • No other in-origin script can read it via a storage API; a reference to
//     this closure is required, which scripts don't have.
// (Against an *active* in-origin XSS, neither this nor a Web Worker fully
// protects — an attacker can call the keystore's own decrypt functions — so
// this captures the concrete win without a heavy realm-isolation refactor.)
const cachedKeys = new Map<string, Uint8Array>();

function cacheKey(username: string, key: Uint8Array): void {
	cachedKeys.set(username, key);
}

function readCachedKey(username: string): Uint8Array | null {
	return cachedKeys.get(username) ?? null;
}

export function isUnlocked(username: string): boolean {
	return cachedKeys.has(username);
}

export function lock(username: string): void {
	cachedKeys.delete(username);
}

// Clears every in-memory unlock key. Used by panic wipe so the key is gone
// immediately, not only after the post-wipe reload.
export function lockAll(): void {
	cachedKeys.clear();
}

function requireCachedKey(username: string): Uint8Array {
	const key = readCachedKey(username);
	if (!key) throw new Error(`Keystore for ${username} is locked — call unlock() first.`);
	return key;
}

// ---- identity lifecycle ----

export async function hasLocalIdentity(username: string): Promise<boolean> {
	return (await getRecord<StoredIdentityRecord>(IDENTITY_STORE, username)) !== undefined;
}

export interface NewIdentityMaterial {
	identity: IdentityKeyPair;
	signedPreKey: SignedPreKey;
	oneTimePreKeys: OneTimePreKey[];
}

// Generates a fresh identity, persists it encrypted, and caches the derived
// key for this tab. Returns the public material the caller must publish to
// the server (POST /api/keys/publish) — this function only touches local
// storage.
export async function createIdentity(username: string, password: string): Promise<NewIdentityMaterial> {
	const identity = generateIdentityKeyPair();
	const signedPreKey = generateSignedPreKey(identity);
	const oneTimePreKeys = generateOneTimePreKeys(20);

	const doc: StoredIdentityDoc = {
		identity: {
			signingPublicKey: bytesToBase64(identity.signing.publicKey),
			signingSecretKey: bytesToBase64(identity.signing.secretKey),
			dhPublicKey: bytesToBase64(identity.dh.publicKey),
			dhSecretKey: bytesToBase64(identity.dh.secretKey),
		},
		signedPreKey: {
			publicKey: bytesToBase64(signedPreKey.keyPair.publicKey),
			secretKey: bytesToBase64(signedPreKey.keyPair.secretKey),
			signature: bytesToBase64(signedPreKey.signature),
		},
		oneTimePreKeys: Object.fromEntries(
			oneTimePreKeys.map((opk) => [bytesToBase64(opk.keyPair.publicKey), bytesToBase64(opk.keyPair.secretKey)])
		),
		contacts: {},
	};

	// A fresh random master key encrypts every store; it's wrapped under the
	// password in the record. The cached key IS the master key from here on.
	const masterKey = generateMasterKey();
	const record = await sealIdentityRecord(doc, password, masterKey);
	await putRecord<StoredIdentityRecord>(IDENTITY_STORE, username, record);
	cacheKey(username, masterKey);

	return { identity, signedPreKey, oneTimePreKeys };
}

export type UnlockResult =
	| { status: 'no-local-identity' }
	| { status: 'wrong-password' }
	| { status: 'unlocked'; identity: IdentityKeyPair };

export async function unlock(username: string, password: string): Promise<UnlockResult> {
	const record = await getRecord<StoredIdentityRecord>(IDENTITY_STORE, username);
	if (!record) return { status: 'no-local-identity' };

	let doc: StoredIdentityDoc;
	let masterKey: Uint8Array;
	try {
		const opened = await openIdentityRecord<StoredIdentityDoc>(record, password);
		doc = opened.doc;
		masterKey = opened.masterKey;
		// A legacy v1 record migrated to v2 on open (same key, same blob, added
		// wrap) — persist it so the next unlock is a plain v2 open.
		if (opened.migrated) await putRecord<StoredIdentityRecord>(IDENTITY_STORE, username, opened.migrated);
	} catch (err) {
		if (err instanceof WrongPasswordError) return { status: 'wrong-password' };
		throw err;
	}

	cacheKey(username, masterKey);
	return {
		status: 'unlocked',
		identity: {
			signing: {
				publicKey: base64ToBytes(doc.identity.signingPublicKey),
				secretKey: base64ToBytes(doc.identity.signingSecretKey),
			},
			dh: {
				publicKey: base64ToBytes(doc.identity.dhPublicKey),
				secretKey: base64ToBytes(doc.identity.dhSecretKey),
			},
		},
	};
}

// ---- change password (D7 §1) — a durable two-wrap dance ----
// MK never changes, so no store is re-encrypted and the cached key stays valid.
// Only the wrap over MK is rewritten. The three steps map onto the server round
// trip: stage BEFORE the call (durable, opens with either password), then either
// finalize (server accepted → keep the new password) or rollback (server rejected
// → keep the old). A crash between stage and settle is safe: the record still
// opens with whichever password the server ended up on, and the next unlock
// collapses it (see openIdentityRecord).

export async function stageChangePassword(
	username: string,
	currentPassword: string,
	newPassword: string
): Promise<'ok' | 'wrong-password'> {
	const record = await getRecord<StoredIdentityRecord>(IDENTITY_STORE, username);
	if (!record) throw new Error(`No local identity for ${username}.`);
	let staged: IdentityRecordV2;
	try {
		staged = await stageRewrap(record, currentPassword, newPassword);
	} catch (err) {
		if (err instanceof WrongPasswordError) return 'wrong-password';
		throw err;
	}
	await putRecord<StoredIdentityRecord>(IDENTITY_STORE, username, staged);
	return 'ok';
}

// Server accepted the change: promote the new password's wrap to be the only one.
export async function finalizeChangePassword(username: string): Promise<void> {
	const record = await getRecord<StoredIdentityRecord>(IDENTITY_STORE, username);
	if (!record || !(record as IdentityRecordV2).altWrap) return;
	await putRecord<StoredIdentityRecord>(IDENTITY_STORE, username, promoteRewrap(record as IdentityRecordV2));
}

// Server rejected the change: drop the staged wrap, keeping the old password.
export async function rollbackChangePassword(username: string): Promise<void> {
	const record = await getRecord<StoredIdentityRecord>(IDENTITY_STORE, username);
	if (!record || !(record as IdentityRecordV2).altWrap) return;
	await putRecord<StoredIdentityRecord>(IDENTITY_STORE, username, abortRewrap(record as IdentityRecordV2));
}

// ---- biometric unlock (D7 §5, native) ----
// Store the master key in a Secure-Enclave-gated Keychain item (the custom
// FlatFoldBiometric plugin) so a future unlock can retrieve MK with Face ID
// instead of the password. MK is stored DIRECTLY — the OS gate IS the protection,
// so there's nothing to wrap, and because a password change never changes MK, the
// gated secret keeps working across one. The password + recovery code remain the
// ultimate secrets; this is on-device convenience and never leaves the device.

function biometricKey(username: string): string {
	return `mk:${username}`;
}

// Requires the keystore to be unlocked (MK cached). Stores the cached MK gated by
// biometrics.
export async function enrollBiometric(username: string): Promise<void> {
	const mk = requireCachedKey(username);
	await biometricSetSecret(biometricKey(username), bytesToBase64(mk));
}

export async function isBiometricEnrolled(username: string): Promise<boolean> {
	return biometricHasSecret(biometricKey(username));
}

export async function disableBiometric(username: string): Promise<void> {
	await biometricDeleteSecret(biometricKey(username));
}

export type BiometricUnlockResult =
	| { status: 'unlocked'; identity: IdentityKeyPair }
	| { status: 'cancelled' }
	| { status: 'no-local-identity' };

// Retrieve MK from the gated Keychain (triggers the OS Face ID sheet), cache it,
// and return the identity. 'cancelled' if the user cancels/fails or no secret is
// stored — the caller falls back to the password gate.
export async function unlockWithBiometric(username: string): Promise<BiometricUnlockResult> {
	const record = await getRecord<StoredIdentityRecord>(IDENTITY_STORE, username);
	if (!record) return { status: 'no-local-identity' };
	const mkB64 = await biometricGetSecret(biometricKey(username), 'Unlock FlatFold');
	if (!mkB64) return { status: 'cancelled' };
	const masterKey = base64ToBytes(mkB64);
	let doc: StoredIdentityDoc;
	try {
		doc = decryptBlob<StoredIdentityDoc>(masterKey, record.blob);
	} catch {
		// The stored MK no longer opens the record — drop the stale secret and
		// fall back to the password.
		await biometricDeleteSecret(biometricKey(username));
		return { status: 'cancelled' };
	}
	cacheKey(username, masterKey);
	return {
		status: 'unlocked',
		identity: {
			signing: {
				publicKey: base64ToBytes(doc.identity.signingPublicKey),
				secretKey: base64ToBytes(doc.identity.signingSecretKey),
			},
			dh: { publicKey: base64ToBytes(doc.identity.dhPublicKey), secretKey: base64ToBytes(doc.identity.dhSecretKey) },
		},
	};
}

// ---- recovery code (D7 §3) ----
// Opt-in. Because we NEVER retain the recovery code after enrollment (shown once,
// the user writes it down), the recovery blob is a SNAPSHOT taken at enroll time,
// not a live mirror — we can't re-derive its key later. We back up the identity
// KEYPAIR (so a restored account keeps the same keys → no safety-number change
// for contacts) plus the CONTACTS as of enrollment. Message history is never in
// the blob — it only ever lived in this device's IndexedDB. On restore the
// ephemeral prekeys are regenerated fresh (signed by the restored identity).

interface RecoveryPayload {
	identity: StoredIdentityDoc['identity'];
	contacts: Record<string, StoredContact>;
}

// Build the (opt-in) recovery enrollment for the CURRENTLY UNLOCKED user. Returns
// the code to show ONCE plus the payload to upload (opaque blob + authenticator).
export async function enrollRecovery(username: string): Promise<{ code: string; enrollment: RecoveryEnrollment }> {
	const { doc } = await loadDoc(username);
	const payload: RecoveryPayload = { identity: doc.identity, contacts: doc.contacts };
	const secret = new TextEncoder().encode(JSON.stringify(payload));
	const code = generateRecoveryCode();
	const enrollment = await buildRecoveryEnrollment(code, secret);
	return { code, enrollment };
}

// Rebuild a working local identity from a recovery code + the server-held blob
// (new device / reinstall). Restores the SAME identity keypair and contacts,
// regenerates fresh signed-prekey + one-time prekeys, and seals everything under
// a NEW password. Returns the public material to (re)publish — the identity
// pubkey is unchanged, so contacts see no safety-number change. Throws
// InvalidRecoveryCodeError on a wrong code (nothing is written).
export async function restoreFromRecovery(
	username: string,
	code: string,
	saltRec: string,
	blob: EncryptedBlob,
	newPassword: string
): Promise<NewIdentityMaterial> {
	const secret = await openRecoveryBlob(code, saltRec, blob); // throws InvalidRecoveryCodeError
	const payload = JSON.parse(new TextDecoder().decode(secret)) as RecoveryPayload;

	const identity: IdentityKeyPair = {
		signing: {
			publicKey: base64ToBytes(payload.identity.signingPublicKey),
			secretKey: base64ToBytes(payload.identity.signingSecretKey),
		},
		dh: { publicKey: base64ToBytes(payload.identity.dhPublicKey), secretKey: base64ToBytes(payload.identity.dhSecretKey) },
	};
	// Fresh ephemeral material, tied to the restored identity — the old snapshot's
	// prekeys may be stale/consumed on the server.
	const signedPreKey = generateSignedPreKey(identity);
	const oneTimePreKeys = generateOneTimePreKeys(20);

	const doc: StoredIdentityDoc = {
		identity: payload.identity,
		signedPreKey: {
			publicKey: bytesToBase64(signedPreKey.keyPair.publicKey),
			secretKey: bytesToBase64(signedPreKey.keyPair.secretKey),
			signature: bytesToBase64(signedPreKey.signature),
		},
		oneTimePreKeys: Object.fromEntries(
			oneTimePreKeys.map((opk) => [bytesToBase64(opk.keyPair.publicKey), bytesToBase64(opk.keyPair.secretKey)])
		),
		contacts: payload.contacts ?? {},
	};

	const masterKey = generateMasterKey();
	const record = await sealIdentityRecord(doc, newPassword, masterKey);
	await putRecord<StoredIdentityRecord>(IDENTITY_STORE, username, record);
	cacheKey(username, masterKey);

	return { identity, signedPreKey, oneTimePreKeys };
}

async function loadDoc(username: string): Promise<{ key: Uint8Array; doc: StoredIdentityDoc }> {
	const key = requireCachedKey(username);
	const record = await getRecord<StoredIdentityRecord>(IDENTITY_STORE, username);
	if (!record) throw new Error(`No local identity for ${username}.`);
	return { key, doc: decryptBlob<StoredIdentityDoc>(key, record.blob) };
}

async function saveDoc(username: string, key: Uint8Array, doc: StoredIdentityDoc): Promise<void> {
	const record = await getRecord<StoredIdentityRecord>(IDENTITY_STORE, username);
	if (!record) throw new Error(`No local identity for ${username}.`);
	// Preserve the record envelope (version + wrap + salt); only the doc changes.
	// `key` is the master key, so the doc stays MK-encrypted.
	await putRecord<StoredIdentityRecord>(IDENTITY_STORE, username, { ...record, blob: encryptBlob(key, doc) });
}

export async function getIdentity(username: string): Promise<IdentityKeyPair> {
	const { doc } = await loadDoc(username);
	return {
		signing: {
			publicKey: base64ToBytes(doc.identity.signingPublicKey),
			secretKey: base64ToBytes(doc.identity.signingSecretKey),
		},
		dh: { publicKey: base64ToBytes(doc.identity.dhPublicKey), secretKey: base64ToBytes(doc.identity.dhSecretKey) },
	};
}

export async function getSignedPreKey(username: string): Promise<SignedPreKey> {
	const { doc } = await loadDoc(username);
	return {
		keyPair: {
			publicKey: base64ToBytes(doc.signedPreKey.publicKey),
			secretKey: base64ToBytes(doc.signedPreKey.secretKey),
		},
		signature: base64ToBytes(doc.signedPreKey.signature),
	};
}

// Looks up (and permanently removes) the secret key for one of THIS user's
// own one-time prekeys, identified by its public key — used when responding
// to an incoming first message that names which OPK the sender consumed.
// Removing it locally is a second no-reuse guarantee independent of the
// server's own atomic delete-on-fetch (worker/keys.ts).
// Generates `count` fresh one-time prekeys, PERSISTS their secrets into this
// user's encrypted doc, and returns the public keys (base64) for publishing.
//
// The ordering is the whole point, and it mirrors D7's stageRewrap: the secrets
// are durably saved before this returns, so a caller can only ever publish keys
// we can already complete a handshake with. If the subsequent publish fails (or
// the app dies first), the extra local secrets are harmless — nothing claims
// them, and the next replenishment tops up again. The reverse order would put
// public keys on the server whose secrets we might never have stored, silently
// wedging first contact for whoever claimed one (the server deletes each prekey
// on use, so that conversation could not recover).
//
// Why this exists: the initial batch is generated ONCE at identity creation and
// consumed one per first contact, so without replenishment an ordinary account
// runs dry and every later contact degrades to no-OTP X3DH (FULL_AUDIT §2).
export async function addOneTimePreKeys(username: string, count: number): Promise<string[]> {
	if (count <= 0) return [];
	const { key, doc } = await loadDoc(username);
	const fresh = generateOneTimePreKeys(count);
	for (const opk of fresh) {
		doc.oneTimePreKeys[bytesToBase64(opk.keyPair.publicKey)] = bytesToBase64(opk.keyPair.secretKey);
	}
	await saveDoc(username, key, doc); // durable BEFORE the caller can publish
	return fresh.map((opk) => bytesToBase64(opk.keyPair.publicKey));
}

export async function takeOneTimePreKeySecret(username: string, publicKeyBase64: string): Promise<Uint8Array | null> {
	const { key, doc } = await loadDoc(username);
	const secretBase64 = doc.oneTimePreKeys[publicKeyBase64];
	if (!secretBase64) return null;

	delete doc.oneTimePreKeys[publicKeyBase64];
	await saveDoc(username, key, doc);
	return base64ToBytes(secretBase64);
}

// Adds a brand-new contact (unverified, no key-change flag). Idempotent for
// an unchanged identity; use recordKeyChange when a KNOWN contact's identity
// changes so the verification/warning state is handled correctly.
export async function addContact(username: string, contactUsername: string, identity: IdentityPublicKeys): Promise<void> {
	const { key, doc } = await loadDoc(username);
	doc.contacts[contactUsername] = {
		signingPublicKey: bytesToBase64(identity.signingPublicKey),
		dhPublicKey: bytesToBase64(identity.dhPublicKey),
		verified: false,
		keyChangeUnacknowledged: false,
	};
	await saveDoc(username, key, doc);
}

export interface ContactRecord {
	username: string;
	identity: IdentityPublicKeys;
	verified: boolean;
	keyChangeUnacknowledged: boolean;
	disappearingSeconds: number;
}

function toContactRecord(contactUsername: string, stored: StoredContact): ContactRecord {
	return {
		username: contactUsername,
		identity: {
			signingPublicKey: base64ToBytes(stored.signingPublicKey),
			dhPublicKey: base64ToBytes(stored.dhPublicKey),
		},
		verified: stored.verified ?? false,
		keyChangeUnacknowledged: stored.keyChangeUnacknowledged ?? false,
		disappearingSeconds: stored.disappearingSeconds ?? 0,
	};
}

export async function setDisappearingTimer(username: string, contactUsername: string, seconds: number): Promise<void> {
	const { key, doc } = await loadDoc(username);
	const stored = doc.contacts[contactUsername];
	if (!stored) return;
	stored.disappearingSeconds = seconds;
	await saveDoc(username, key, doc);
}

export async function listContacts(username: string): Promise<ContactRecord[]> {
	const { doc } = await loadDoc(username);
	return Object.entries(doc.contacts).map(([contactUsername, stored]) => toContactRecord(contactUsername, stored));
}

export async function getContact(username: string, contactUsername: string): Promise<ContactRecord | null> {
	const { doc } = await loadDoc(username);
	const stored = doc.contacts[contactUsername];
	return stored ? toContactRecord(contactUsername, stored) : null;
}

// A known contact's identity key changed. Replace the stored identity, drop
// any prior verification, and raise the unacknowledged-key-change flag that
// drives the non-dismissable warning. This is the detection point Signal
// calls a "safety number change."
export async function recordKeyChange(username: string, contactUsername: string, identity: IdentityPublicKeys): Promise<void> {
	const { key, doc } = await loadDoc(username);
	doc.contacts[contactUsername] = {
		signingPublicKey: bytesToBase64(identity.signingPublicKey),
		dhPublicKey: bytesToBase64(identity.dhPublicKey),
		verified: false,
		keyChangeUnacknowledged: true,
	};
	await saveDoc(username, key, doc);
}

// User confirmed the safety number out-of-band (compared digits, or scanned
// the QR). Clears any pending key-change warning too.
export async function setVerified(username: string, contactUsername: string, verified: boolean): Promise<void> {
	const { key, doc } = await loadDoc(username);
	const stored = doc.contacts[contactUsername];
	if (!stored) return;
	stored.verified = verified;
	if (verified) stored.keyChangeUnacknowledged = false;
	await saveDoc(username, key, doc);
}

// User dismissed the key-change warning without re-verifying — the contact
// stays unverified, but the banner stops nagging.
export async function acknowledgeKeyChange(username: string, contactUsername: string): Promise<void> {
	const { key, doc } = await loadDoc(username);
	const stored = doc.contacts[contactUsername];
	if (!stored) return;
	stored.keyChangeUnacknowledged = false;
	await saveDoc(username, key, doc);
}

// ---- sealed-sender delivery tokens ----

// My own delivery token (the one I register with my mailbox DO + publish in my
// bundle). Not a secret — see src/lib/sealToken.ts. Rotated on contact removal.
export async function saveOwnSealToken(username: string, token: string): Promise<void> {
	const { key, doc } = await loadDoc(username);
	doc.sealToken = token;
	await saveDoc(username, key, doc);
}

export async function loadOwnSealToken(username: string): Promise<string | null> {
	const { doc } = await loadDoc(username);
	return doc.sealToken ?? null;
}

// Store a contact's delivery token (learned over the ratchet or their bundle),
// so a future sealed send to them can present it. No-op for an unknown contact.
export async function savePeerSealToken(username: string, contactUsername: string, token: string): Promise<void> {
	const { key, doc } = await loadDoc(username);
	const stored = doc.contacts[contactUsername];
	if (!stored) return;
	stored.sealToken = token;
	await saveDoc(username, key, doc);
}

export async function loadPeerSealToken(username: string, contactUsername: string): Promise<string | null> {
	const { doc } = await loadDoc(username);
	return doc.contacts[contactUsername]?.sealToken ?? null;
}

// Removes a 1:1 contact and all local state for that conversation: the contact
// record (identity, verification, their delivery token), the ratchet session,
// message history, and the chat-list summary. Mirrors group removal's local
// purge. Triggers a delivery-token rotation at the call site (Chat.tsx) so the
// removed contact's copy of my token goes stale after the DO's grace window.
export async function removeContact(username: string, contactUsername: string): Promise<void> {
	const { key, doc } = await loadDoc(username);
	delete doc.contacts[contactUsername];
	await saveDoc(username, key, doc);
	await deleteRecord(SESSION_STORE, sessionKey(username, contactUsername));
	await deleteRecord(MESSAGE_STORE, sessionKey(username, contactUsername));
	await deleteConversationSummary(username, contactUsername);
}

// ---- ratchet sessions (one record per contact, separate from the
// identity doc so a chatty conversation doesn't rewrite the whole identity
// blob — including every other contact and remaining OPKs — on each message)

function sessionKey(username: string, contactUsername: string): string {
	return `${username}:${contactUsername}`;
}

function toStoredEntry(ratchet: RatchetState, associatedData: Uint8Array): StoredSession {
	return { associatedData: bytesToBase64(associatedData), ratchet: serializeRatchetState(ratchet) };
}

function fromStoredEntry(stored: StoredSession): { ratchet: RatchetState; associatedData: Uint8Array } {
	return { ratchet: deserializeRatchetState(stored.ratchet), associatedData: base64ToBytes(stored.associatedData) };
}

/** The raw stored set for a contact, tolerating the legacy single-session shape. */
async function readSessionRecord(username: string, contactUsername: string): Promise<StoredSessionRecord | null> {
	const key = requireCachedKey(username);
	const blob = await getRecord<EncryptedBlob>(SESSION_STORE, sessionKey(username, contactUsername));
	if (!blob) return null;
	return normalizeSessionRecord(decryptBlob<StoredSessionBlob>(key, blob) as StoredSessionBlob);
}

async function writeSessionRecord(username: string, contactUsername: string, record: StoredSessionRecord): Promise<void> {
	const key = requireCachedKey(username);
	await putRecord(SESSION_STORE, sessionKey(username, contactUsername), encryptBlob(key, record));
}

/**
 * Persist the CURRENT session, leaving any others intact.
 *
 * The send path calls this after every message to store the advanced ratchet.
 * It must not rewrite the whole record: a contact can hold additional sessions
 * retained to read a glare peer, and clobbering them makes that peer's messages
 * permanently undecryptable. Creates the record when there isn't one.
 */
export async function saveSession(
	username: string,
	contactUsername: string,
	ratchet: RatchetState,
	associatedData: Uint8Array
): Promise<void> {
	const existing = await readSessionRecord(username, contactUsername);
	const entry = toStoredEntry(ratchet, associatedData);
	if (!existing) {
		await writeSessionRecord(username, contactUsername, { sessions: [entry], current: 0 });
		return;
	}
	const sessions = [...existing.sessions];
	sessions[existing.current] = entry;
	await writeSessionRecord(username, contactUsername, { sessions, current: existing.current });
}

/**
 * Discard every session held for a contact and start over with this one.
 *
 * Used when a contact re-handshakes under a DIFFERENT identity (reinstall,
 * cleared data — or a man-in-the-middle presenting a fresh identity). Prior
 * session state must go wholesale: anything retained would stay a live
 * trial-decrypt candidate keyed to an identity we've just stopped trusting.
 * Distinct from saveSession, which deliberately preserves siblings.
 */
export async function replaceSessionSet(
	username: string,
	contactUsername: string,
	ratchet: RatchetState,
	associatedData: Uint8Array
): Promise<void> {
	await writeSessionRecord(username, contactUsername, { sessions: [toStoredEntry(ratchet, associatedData)], current: 0 });
}

/** Persist one session of the set by index — used after a trial decrypt advances it. */
export async function saveSessionAt(
	username: string,
	contactUsername: string,
	index: number,
	ratchet: RatchetState,
	associatedData: Uint8Array
): Promise<void> {
	const existing = await readSessionRecord(username, contactUsername);
	if (!existing || index < 0 || index >= existing.sessions.length) return;
	const sessions = [...existing.sessions];
	sessions[index] = toStoredEntry(ratchet, associatedData);
	await writeSessionRecord(username, contactUsername, { sessions, current: existing.current });
}

/**
 * Add a session to a contact's set. `makeCurrent` decides whether outgoing
 * messages move to it — the glare tie-break's yield (see sessionSet.ts).
 */
export async function addSession(
	username: string,
	contactUsername: string,
	ratchet: RatchetState,
	associatedData: Uint8Array,
	makeCurrent: boolean
): Promise<void> {
	const existing = await readSessionRecord(username, contactUsername);
	const entry = toStoredEntry(ratchet, associatedData);
	if (!existing) {
		await writeSessionRecord(username, contactUsername, { sessions: [entry], current: 0 });
		return;
	}
	const sessions = [...existing.sessions, entry];
	const current = makeCurrent ? sessions.length - 1 : existing.current;
	await writeSessionRecord(username, contactUsername, capSessions(sessions, current));
}

/** Every session held for a contact, plus which one sends. */
export async function loadSessionSet(
	username: string,
	contactUsername: string
): Promise<{ sessions: { ratchet: RatchetState; associatedData: Uint8Array }[]; current: number } | null> {
	const record = await readSessionRecord(username, contactUsername);
	if (!record) return null;
	return { sessions: record.sessions.map(fromStoredEntry), current: record.current };
}

/** The session outgoing messages are encrypted on. */
export async function loadSession(
	username: string,
	contactUsername: string
): Promise<{ ratchet: RatchetState; associatedData: Uint8Array } | null> {
	const record = await readSessionRecord(username, contactUsername);
	if (!record) return null;
	return fromStoredEntry(record.sessions[record.current]);
}

export async function hasSession(username: string, contactUsername: string): Promise<boolean> {
	return (await getRecord(SESSION_STORE, sessionKey(username, contactUsername))) !== undefined;
}

// Every contact we hold a 1:1 ratchet session with. Sealed-sender receive uses
// this to trial-decrypt an incoming from-less envelope against each candidate
// session until one's header key decrypts it (identifying the sender). Mirrors
// the `${username}:` prefix scan used by loadAllMessages / summaries.
export async function listSessionContacts(username: string): Promise<string[]> {
	const prefix = `${username}:`;
	const keys = await listKeys(SESSION_STORE);
	return keys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

// ---- decrypted message history (one record per conversation) ----
// Stored encrypted under the same derived key as everything else — "no
// server-side message store" doesn't mean "no history"; it means history
// lives only here, client-side.

export async function appendMessage(username: string, contactUsername: string, message: DisplayMessage): Promise<void> {
	const key = requireCachedKey(username);
	const storeKey = sessionKey(username, contactUsername);
	const existingBlob = await getRecord<EncryptedBlob>(MESSAGE_STORE, storeKey);
	const history = existingBlob ? decryptBlob<DisplayMessage[]>(key, existingBlob) : [];
	history.push(message);
	await putRecord(MESSAGE_STORE, storeKey, encryptBlob(key, history));
}

export async function loadMessages(username: string, contactUsername: string): Promise<DisplayMessage[]> {
	const key = requireCachedKey(username);
	const blob = await getRecord<EncryptedBlob>(MESSAGE_STORE, sessionKey(username, contactUsername));
	return blob ? decryptBlob<DisplayMessage[]>(key, blob) : [];
}

// Every conversation's decrypted history, tagged by contact. Used to build
// the in-memory local search index — which is NEVER persisted, so search
// touches neither the network nor plaintext-at-rest.
export async function loadAllMessages(username: string): Promise<{ contact: string; message: DisplayMessage }[]> {
	const key = requireCachedKey(username);
	const prefix = `${username}:`;
	const all: { contact: string; message: DisplayMessage }[] = [];
	for (const storeKey of await listKeys(MESSAGE_STORE)) {
		if (!storeKey.startsWith(prefix)) continue;
		const blob = await getRecord<EncryptedBlob>(MESSAGE_STORE, storeKey);
		if (!blob) continue;
		const contact = storeKey.slice(prefix.length);
		for (const message of decryptBlob<DisplayMessage[]>(key, blob)) all.push({ contact, message });
	}
	return all;
}

// Resolve a sealed delivered-receipt's `rid` back to the local sent message it
// refers to, WITHOUT the receipt carrying a conversation identity. Scans the
// (encrypted) per-conversation history — the same store the in-memory ridIndex
// is built from, so no new plaintext-at-rest index of contact identities. Only
// hit on a receipt whose rid isn't already in the in-memory map (a receipt for
// a conversation not opened this session, e.g. flushed after a reload). Returns
// the first match's `{contact, messageId}` (rid is per-message unique).
export async function findMessageByRid(username: string, rid: string): Promise<{ contact: string; messageId: string } | null> {
	const key = requireCachedKey(username);
	const prefix = `${username}:`;
	for (const storeKey of await listKeys(MESSAGE_STORE)) {
		if (!storeKey.startsWith(prefix)) continue;
		const blob = await getRecord<EncryptedBlob>(MESSAGE_STORE, storeKey);
		if (!blob) continue;
		const match = decryptBlob<DisplayMessage[]>(key, blob).find((m) => m.rid === rid);
		if (match) return { contact: storeKey.slice(prefix.length), messageId: match.id };
	}
	return null;
}

// Deletes expired disappearing messages from every conversation, returning
// the set of contacts whose history changed (so the UI can refresh just
// those). Both sides run this on the same `expiresAt` wall-clock, so a
// message vanishes from both devices at the same moment.
export async function sweepExpiredMessages(username: string, now: number): Promise<string[]> {
	const key = requireCachedKey(username);
	const prefix = `${username}:`;
	const changed: string[] = [];
	for (const storeKey of await listKeys(MESSAGE_STORE)) {
		if (!storeKey.startsWith(prefix)) continue;
		const blob = await getRecord<EncryptedBlob>(MESSAGE_STORE, storeKey);
		if (!blob) continue;
		const history = decryptBlob<DisplayMessage[]>(key, blob);
		const kept: DisplayMessage[] = [];
		const expired: DisplayMessage[] = [];
		for (const m of history) (m.expiresAt !== undefined && m.expiresAt <= now ? expired : kept).push(m);
		if (expired.length > 0) {
			await putRecord(MESSAGE_STORE, storeKey, encryptBlob(key, kept));
			// A disappearing media message must take its locally-cached bytes
			// with it, not just the bubble.
			for (const m of expired) {
				if (m.media) await deleteRecord(MEDIA_CACHE_STORE, mediaCacheKey(username, m.media.id));
			}
			changed.push(storeKey.slice(prefix.length));
		}
	}
	return changed;
}

// Upgrades a previously-stored own message to 'delivered' (or any later
// status) once its delivered notification arrives. No-op if the message
// isn't found — a delivered notification can outlive its message record
// (e.g. after a panic wipe), and that shouldn't throw.
export async function updateMessageStatus(
	username: string,
	contactUsername: string,
	messageId: string,
	status: 'sent' | 'delivered'
): Promise<void> {
	const key = requireCachedKey(username);
	const storeKey = sessionKey(username, contactUsername);
	const blob = await getRecord<EncryptedBlob>(MESSAGE_STORE, storeKey);
	if (!blob) return;
	const history = decryptBlob<DisplayMessage[]>(key, blob);
	const target = history.find((m) => m.id === messageId);
	if (!target) return;
	target.status = status;
	await putRecord(MESSAGE_STORE, storeKey, encryptBlob(key, history));
}

// Hard-removes a single message from a conversation's local history ("delete
// for me" — a purely local action, no network). Also drops its cached media
// bytes. Returns true if a message was removed. Idempotent: a no-op (returns
// false) if the id isn't present.
export async function deleteMessageLocal(username: string, convoKey: string, messageId: string): Promise<boolean> {
	const key = requireCachedKey(username);
	const storeKey = sessionKey(username, convoKey);
	const blob = await getRecord<EncryptedBlob>(MESSAGE_STORE, storeKey);
	if (!blob) return false;
	const history = decryptBlob<DisplayMessage[]>(key, blob);
	const target = history.find((m) => m.id === messageId);
	const next = history.filter((m) => m.id !== messageId);
	if (next.length === history.length) return false;
	await putRecord(MESSAGE_STORE, storeKey, encryptBlob(key, next));
	if (target?.media) await deleteRecord(MEDIA_CACHE_STORE, mediaCacheKey(username, target.media.id));
	return true;
}

// Tombstones a message ("delete for everyone"): keeps the record so the bubble
// can render "deleted", but clears its content (text, media, reply quote) and
// drops any cached media bytes. Returns true if it changed anything. Idempotent:
// a no-op (returns false) if the id is missing or already tombstoned.
//
// AUTHORIZATION for the remote path is the caller's job (see canDelete in
// deleteAuth.ts): only call this after confirming the requester authored the
// target, and look the target up ONLY in the requester's own conversation.
export async function tombstoneMessage(username: string, convoKey: string, messageId: string): Promise<boolean> {
	const key = requireCachedKey(username);
	const storeKey = sessionKey(username, convoKey);
	const blob = await getRecord<EncryptedBlob>(MESSAGE_STORE, storeKey);
	if (!blob) return false;
	const history = decryptBlob<DisplayMessage[]>(key, blob);
	const target = history.find((m) => m.id === messageId);
	if (!target || target.deleted) return false;
	const mediaId = target.media?.id;
	target.deleted = true;
	target.text = '';
	delete target.media;
	delete target.replyTo;
	await putRecord(MESSAGE_STORE, storeKey, encryptBlob(key, history));
	if (mediaId) await deleteRecord(MEDIA_CACHE_STORE, mediaCacheKey(username, mediaId));
	return true;
}

// ---- conversation summaries (chat-list previews + unread) ----
// A denormalized, per-conversation snapshot of the last message plus a
// lastRead marker, so the chat list can show a preview + timestamp + unread
// dot WITHOUT decrypting every conversation's full history on each render.
// This is a cache derived from message history — never authoritative over it.
// The unread dot is computed by the UI as `lastTs > lastReadTs && the last
// message was received (not sent by me)`.

export interface ConversationSummary {
	// Raw text of the last message ('' for media — the UI renders a label from
	// lastKind). Snippet truncation happens at render time.
	lastText: string;
	lastTs: number;
	// Sender username of the last message (=== our own username when we sent it).
	lastFrom: string;
	lastKind: 'text' | 'media' | 'voice';
	// Wall-clock ms of the last time the user viewed this conversation.
	lastReadTs: number;
	// True when the last message was retracted ("delete for everyone") — so the
	// list preview reads "Message deleted" rather than leaking the old text.
	deleted?: boolean;
}

function summaryKey(username: string, convoKey: string): string {
	return `${username}:${convoKey}`;
}

// Persists a conversation's summary (last-message preview + lastRead marker),
// encrypted at rest. The caller (Chat) derives this from message history and
// the active-conversation state; this is just the durable write so previews
// and unread dots survive a reload.
export async function putConversationSummary(username: string, convoKey: string, summary: ConversationSummary): Promise<void> {
	const key = requireCachedKey(username);
	await putRecord(SUMMARY_STORE, summaryKey(username, convoKey), encryptBlob(key, summary));
}

// Removes a conversation's summary — when it has no messages left (all deleted
// or expired), so the chat list stops showing a stale/vanished preview.
export async function deleteConversationSummary(username: string, convoKey: string): Promise<void> {
	await deleteRecord(SUMMARY_STORE, summaryKey(username, convoKey));
}

// Every conversation summary for this user, keyed by convoKey (contact
// username or groupConversationKey). Cheap: one small record per conversation.
export async function listConversationSummaries(username: string): Promise<Record<string, ConversationSummary>> {
	const key = requireCachedKey(username);
	const prefix = `${username}:`;
	const out: Record<string, ConversationSummary> = {};
	for (const storeKey of await listKeys(SUMMARY_STORE)) {
		if (!storeKey.startsWith(prefix)) continue;
		const blob = await getRecord<EncryptedBlob>(SUMMARY_STORE, storeKey);
		if (!blob) continue;
		out[storeKey.slice(prefix.length)] = decryptBlob<ConversationSummary>(key, blob);
	}
	return out;
}

// ---- processed inbound message ids (idempotent receive) ----
// A tiny encrypted record per handled message id. The value is just a
// timestamp, kept so a future pass can prune ids older than the 14-day
// envelope TTL (after which no redelivery can occur); not pruned yet —
// documented growth caveat in ARCHITECTURE.md.

function processedKey(username: string, messageId: string): string {
	return `${username}:${messageId}`;
}

export async function markProcessed(username: string, messageId: string): Promise<void> {
	const key = requireCachedKey(username);
	await putRecord(PROCESSED_STORE, processedKey(username, messageId), encryptBlob(key, { at: Date.now() }));
}

export async function isProcessed(username: string, messageId: string): Promise<boolean> {
	return (await getRecord(PROCESSED_STORE, processedKey(username, messageId))) !== undefined;
}

// ---- decrypted-attachment cache (encrypted at rest) ----

interface StoredMedia {
	bytesBase64: string;
	mimeType: string;
}

function mediaCacheKey(username: string, mediaId: string): string {
	return `${username}:${mediaId}`;
}

export async function cacheMedia(username: string, mediaId: string, bytes: Uint8Array, mimeType: string): Promise<void> {
	const key = requireCachedKey(username);
	const stored: StoredMedia = { bytesBase64: bytesToBase64(bytes), mimeType };
	await putRecord(MEDIA_CACHE_STORE, mediaCacheKey(username, mediaId), encryptBlob(key, stored));
}

export async function getCachedMedia(username: string, mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
	const key = requireCachedKey(username);
	const blob = await getRecord<EncryptedBlob>(MEDIA_CACHE_STORE, mediaCacheKey(username, mediaId));
	if (!blob) return null;
	const stored = decryptBlob<StoredMedia>(key, blob);
	return { bytes: base64ToBytes(stored.bytesBase64), mimeType: stored.mimeType };
}

// ---- groups (M5) ----
// Group state is client-only and encrypted at rest; the server sees only
// opaque group ids and per-member mailbox fan-out.

export interface GroupRecord {
	id: string;
	name: string;
	members: string[];
	creator: string;
}

function groupKey(username: string, groupId: string): string {
	return `${username}:${groupId}`;
}

export async function saveGroup(username: string, group: GroupRecord): Promise<void> {
	const key = requireCachedKey(username);
	await putRecord(GROUP_STORE, groupKey(username, group.id), encryptBlob(key, group));
}

export async function getGroup(username: string, groupId: string): Promise<GroupRecord | null> {
	const key = requireCachedKey(username);
	const blob = await getRecord<EncryptedBlob>(GROUP_STORE, groupKey(username, groupId));
	return blob ? decryptBlob<GroupRecord>(key, blob) : null;
}

export async function listGroups(username: string): Promise<GroupRecord[]> {
	const key = requireCachedKey(username);
	const prefix = `${username}:`;
	const groups: GroupRecord[] = [];
	for (const storeKey of await listKeys(GROUP_STORE)) {
		if (!storeKey.startsWith(prefix)) continue;
		const blob = await getRecord<EncryptedBlob>(GROUP_STORE, storeKey);
		if (blob) groups.push(decryptBlob<GroupRecord>(key, blob));
	}
	return groups;
}

interface StoredSenderKey {
	chainKey: string;
	iteration: number;
	signingPublicKey: string;
	signingSecretKey: string;
}

export async function saveOwnSenderKey(username: string, groupId: string, state: SenderKeyState): Promise<void> {
	const key = requireCachedKey(username);
	const stored: StoredSenderKey = {
		chainKey: bytesToBase64(state.chainKey),
		iteration: state.iteration,
		signingPublicKey: bytesToBase64(state.signing.publicKey),
		signingSecretKey: bytesToBase64(state.signing.secretKey),
	};
	await putRecord(GROUP_SENDER_STORE, groupKey(username, groupId), encryptBlob(key, stored));
}

export async function loadOwnSenderKey(username: string, groupId: string): Promise<SenderKeyState | null> {
	const key = requireCachedKey(username);
	const blob = await getRecord<EncryptedBlob>(GROUP_SENDER_STORE, groupKey(username, groupId));
	if (!blob) return null;
	const stored = decryptBlob<StoredSenderKey>(key, blob);
	return {
		chainKey: base64ToBytes(stored.chainKey),
		iteration: stored.iteration,
		signing: { publicKey: base64ToBytes(stored.signingPublicKey), secretKey: base64ToBytes(stored.signingSecretKey) },
	};
}

interface StoredReceiverKey {
	chainKey: string;
	iteration: number;
	signPublicKey: string;
	skippedMessageKeys: [number, string][];
}

function receiverKey(username: string, groupId: string, sender: string): string {
	return `${username}:${groupId}:${sender}`;
}

export async function saveReceiverSenderKey(
	username: string,
	groupId: string,
	sender: string,
	state: ReceiverSenderKeyState
): Promise<void> {
	const key = requireCachedKey(username);
	const stored: StoredReceiverKey = {
		chainKey: bytesToBase64(state.chainKey),
		iteration: state.iteration,
		signPublicKey: bytesToBase64(state.signPublicKey),
		skippedMessageKeys: Array.from(state.skippedMessageKeys.entries()).map(([i, k]) => [i, bytesToBase64(k)]),
	};
	await putRecord(GROUP_RECEIVER_STORE, receiverKey(username, groupId, sender), encryptBlob(key, stored));
}

export async function loadReceiverSenderKey(username: string, groupId: string, sender: string): Promise<ReceiverSenderKeyState | null> {
	const key = requireCachedKey(username);
	const blob = await getRecord<EncryptedBlob>(GROUP_RECEIVER_STORE, receiverKey(username, groupId, sender));
	if (!blob) return null;
	const stored = decryptBlob<StoredReceiverKey>(key, blob);
	return {
		chainKey: base64ToBytes(stored.chainKey),
		iteration: stored.iteration,
		signPublicKey: base64ToBytes(stored.signPublicKey),
		skippedMessageKeys: new Map(stored.skippedMessageKeys.map(([i, k]) => [i, base64ToBytes(k)])),
	};
}

// Purge a removed member's sender key so their retained chain key can no
// longer be tracked here (they've been rotated out anyway).
export async function deleteReceiverSenderKey(username: string, groupId: string, sender: string): Promise<void> {
	await deleteRecord(GROUP_RECEIVER_STORE, receiverKey(username, groupId, sender));
}

// Removes ALL local state for a group (metadata, own sender key, every
// received sender key). Used when we're removed from a group.
export async function deleteGroup(username: string, groupId: string): Promise<void> {
	await deleteRecord(GROUP_STORE, groupKey(username, groupId));
	await deleteRecord(GROUP_SENDER_STORE, groupKey(username, groupId));
	const prefix = `${username}:${groupId}:`;
	const keys = await listKeys(GROUP_RECEIVER_STORE);
	await Promise.all(keys.filter((k) => k.startsWith(prefix)).map((k) => deleteRecord(GROUP_RECEIVER_STORE, k)));
}

// Deletes every local key-store record for a user: the identity document
// (identity keys, signed prekey, remaining one-time prekey secrets,
// contacts), every ratchet session, message history, processed-id markers,
// cached media, and group state. Used by account deletion and panic wipe.
export async function wipeAll(username: string): Promise<void> {
	await deleteRecord(IDENTITY_STORE, username);
	const prefix = `${username}:`;
	for (const store of [
		SESSION_STORE,
		MESSAGE_STORE,
		PROCESSED_STORE,
		MEDIA_CACHE_STORE,
		GROUP_STORE,
		GROUP_SENDER_STORE,
		GROUP_RECEIVER_STORE,
		SUMMARY_STORE,
	]) {
		const keys = await listKeys(store);
		await Promise.all(keys.filter((k) => k.startsWith(prefix)).map((k) => deleteRecord(store, k)));
	}
	lock(username);
}
