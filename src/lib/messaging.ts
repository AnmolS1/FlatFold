// Orchestrates X3DH handshakes and Double Ratchet encrypt/decrypt against
// the WS wire protocol, translating between base64 JSON and the crypto
// library's Uint8Array types. Kept separate from the Chat page so that
// component stays about rendering, not protocol wiring.

import {
	generateSenderKey,
	initRatchetAsInitiator,
	initRatchetAsResponder,
	initiateX3DH,
	initReceiverSenderKey,
	openBox,
	ratchetDecrypt,
	ratchetEncrypt,
	respondX3DH,
	sealBox,
	tryRatchetDecrypt,
	senderKeyDecrypt,
	senderKeyDistribution,
	senderKeyEncrypt,
	type IdentityPublicKeys,
} from '../crypto';
import { utf8ToBytes } from '../crypto/primitives';
import { base64ToBytes, bytesToBase64 } from '../keystore/codec';
import * as keystore from '../keystore';
import { apiFetchBundle } from './api';
import { apiFetchBundleAnonymous } from './sealedFetch';
import { decodeChatPayload, encodeChatPayload, type ChatPayload } from './chatPayload';
import { canDelete } from './deleteAuth';
import { displayTsFor } from './messageOrder';
import { generateSealToken } from './sealToken';
import { NO_SEAL_TOKEN, unwrapSealed, wrapSealed } from './sealedWrap';
import type {
	DisplayMessage,
	RatchetHeaderWire,
	WsAckFrame,
	WsGroupMessageFrame,
	WsGroupSendFrame,
	WsMessageFrame,
	WsSendFrame,
	PreKeyBundleResponse,
	X3dhHandshakeWire,
} from '../types';

// Re-exported so the send path (Chat.tsx) imports the sealed-sender surface from
// one place; the wrapper itself lives in ./sealedWrap (keystore-free, testable).
export { deliveredReceiptEnvelope } from './sealedWrap';

// Group "conversations" reuse the message-history store under a namespaced
// key so they don't collide with 1:1 contacts.
export function groupConversationKey(groupId: string): string {
	return `group:${groupId}`;
}
export function isGroupConversation(key: string): boolean {
	return key.startsWith('group:');
}

// The header is now an opaque encrypted blob (M7 header encryption).
function encryptedHeaderToWire(encryptedHeader: Uint8Array): RatchetHeaderWire {
	return { encryptedHeader: bytesToBase64(encryptedHeader) };
}

function encryptedHeaderFromWire(wire: RatchetHeaderWire): Uint8Array {
	return base64ToBytes(wire.encryptedHeader);
}

export type EnsureSessionResult =
	| { status: 'ok'; pendingHandshake: X3dhHandshakeWire | null }
	| { status: 'not-found' }
	| { status: 'not-published' };

export type EnsureContactResult = { status: 'ok' } | { status: 'not-found' } | { status: 'not-published' };

type BundleLookup = { status: 'ok'; bundle: PreKeyBundleResponse } | { status: 'not-found' } | { status: 'not-published' };

// Fetch the peer's bundle ANONYMOUSLY (increment 7) so the server never learns
// who we're about to contact — the send-side half of first-contact sealing.
// Fall back to the authenticated fetch ONLY on a transport/decrypt error
// (degraded privacy, documented, not silently preferred); a clean 'not-found'
// (unknown OR unpublished, indistinguishable by design) is returned as-is. The
// anon path returns no one-time prekey → first-contact X3DH is no-OPK.
async function lookupBundle(contactUsername: string): Promise<BundleLookup> {
	const anon = await apiFetchBundleAnonymous(contactUsername);
	if (anon.status === 'ok') return { status: 'ok', bundle: anon.bundle };
	if (anon.status === 'not-found') return { status: 'not-found' };

	const authed = await apiFetchBundle(contactUsername);
	if (authed.status !== 'ok') return authed;
	return { status: 'ok', bundle: authed.bundle };
}

function identityFromBundle(bundle: PreKeyBundleResponse): IdentityPublicKeys {
	return {
		signingPublicKey: base64ToBytes(bundle.identityPubkey.signingPublicKey),
		dhPublicKey: base64ToBytes(bundle.identityPubkey.dhPublicKey),
	};
}

async function rememberContact(username: string, contactUsername: string, bundle: PreKeyBundleResponse): Promise<void> {
	await keystore.addContact(username, contactUsername, identityFromBundle(bundle));
	// Close the sealed-sender token seam: a first-contact bundle now carries the
	// peer's delivery token, so store it (MUST come after addContact — the store
	// is a no-op for an unknown contact) for a future sealed send to present.
	if (bundle.sealToken) await keystore.savePeerSealToken(username, contactUsername, bundle.sealToken);
}

// Learns a contact — validates they exist and have published keys, and stores
// their identity — WITHOUT establishing a session.
//
// Session creation is deliberately deferred to the first send. Building an
// initiator ratchet at add time is what caused the mutual-add collision: two
// people who add each other before either sends both end up holding an
// initiator session, and the receive path's existing session then shadows the
// incoming x3dh so respondX3DH never runs (see docs/SESSION_COLLISION_OPTIONS.md).
// Not building ratchet state you might never use is better hygiene regardless.
export async function ensureContact(username: string, contactUsername: string): Promise<EnsureContactResult> {
	const looked = await lookupBundle(contactUsername);
	if (looked.status !== 'ok') return looked;
	await rememberContact(username, contactUsername, looked.bundle);
	return { status: 'ok' };
}

// Ensures a Double Ratchet session with `contactUsername` exists, running
// an X3DH handshake if it doesn't. Returns the X3DH material to attach to
// the first outgoing message (null when a session already existed, since
// only the first message of a session carries handshake material).
//
// Called at SEND time (1:1, group sender-key distribution, delivery-token
// distribution) — never at contact-add time. Stands alone: a contact that was
// never explicitly added is learned here.
export async function ensureSession(username: string, contactUsername: string): Promise<EnsureSessionResult> {
	if (await keystore.hasSession(username, contactUsername)) {
		return { status: 'ok', pendingHandshake: null };
	}

	const looked = await lookupBundle(contactUsername);
	if (looked.status !== 'ok') return looked;
	const bundle = looked.bundle;

	const identity = await keystore.getIdentity(username);
	const responderIdentity = identityFromBundle(bundle);
	const responderSignedPreKey = {
		publicKey: base64ToBytes(bundle.signedPrekey.publicKey),
		signature: base64ToBytes(bundle.signedPrekey.signature),
	};
	const responderOneTimePreKey = bundle.oneTimePreKey ? base64ToBytes(bundle.oneTimePreKey) : undefined;

	const handshake = initiateX3DH({
		initiatorIdentity: identity,
		responderIdentity,
		responderSignedPreKey,
		responderOneTimePreKey,
	});
	const ratchet = initRatchetAsInitiator(handshake.sharedSecret, responderSignedPreKey.publicKey);

	await keystore.saveSession(username, contactUsername, ratchet, handshake.associatedData);
	await rememberContact(username, contactUsername, bundle);

	const pendingHandshake: X3dhHandshakeWire = {
		initiatorIdentityDhPublicKey: bytesToBase64(identity.dh.publicKey),
		initiatorIdentitySigningPublicKey: bytesToBase64(identity.signing.publicKey),
		initiatorEphemeralPublicKey: bytesToBase64(handshake.ephemeralPublicKey),
		usedOneTimePreKeyPublicKey: bundle.oneTimePreKey ?? undefined,
	};

	return { status: 'ok', pendingHandshake };
}

// `id` is the client-generated message id (also used for the sender's own
// local DisplayMessage), so a later WsDeliveredFrame carrying the same id
// correlates straight back to that message. `payload` is the typed plaintext
// (text / media / a timer control) — the server only ever sees the resulting
// ciphertext.
export async function encryptForSend(
	username: string,
	contactUsername: string,
	id: string,
	payload: ChatPayload,
	pendingHandshake: X3dhHandshakeWire | null,
	// The sealed-sender wrapper (increment 6): our OWN delivery token + this
	// message's random `rid`, sealed inside the ciphertext so a returning
	// delivered-receipt can reach us and be matched without leaking to the server.
	ownToken: string,
	rid: string
): Promise<WsSendFrame> {
	const session = await keystore.loadSession(username, contactUsername);
	if (!session) throw new Error(`No session with ${contactUsername}.`);

	const { encryptedHeader, ciphertext } = ratchetEncrypt(
		session.ratchet,
		// `su` = our own username, so a sealed first-contact message carries the
		// sender's claimed identity bound inside the AEAD (increment 7).
		wrapSealed(username, ownToken, rid, encodeChatPayload(payload)),
		session.associatedData
	);
	await keystore.saveSession(username, contactUsername, session.ratchet, session.associatedData);

	return {
		type: 'send',
		id,
		to: contactUsername,
		ciphertext: bytesToBase64(ciphertext),
		header: encryptedHeaderToWire(encryptedHeader),
		x3dh: pendingHandshake ?? undefined,
	};
}

export function ackFrame(frame: WsMessageFrame): WsAckFrame {
	// `to` = the sender, so the DO can send them a delivered-receipt. For a
	// sealed (from-less) message we don't know the sender, so we omit it — the
	// DO then just deletes our own queued copy with no reverse hop.
	return { type: 'ack', messageId: frame.id, to: frame.from };
}

// The from-less envelope handed to apiSealedSend, built from the encrypted send
// frame. No `from`/`seq` (the point), and a client-stamped minute-coarsened `ts`
// (the server would stamp it on the normal path). Reuses the SAME ciphertext +
// header the ratchet already produced — never re-encrypt (that desyncs the chain).
export function sealedEnvelopeFromSend(frame: WsSendFrame): WsMessageFrame {
	return {
		type: 'message',
		id: frame.id,
		ciphertext: frame.ciphertext,
		header: frame.header,
		ts: Math.floor(Date.now() / 60000) * 60000,
	};
}

// The sealed FIRST-CONTACT envelope (increment 7): like sealedEnvelopeFromSend,
// but the X3DH handshake is ECIES-encrypted to the recipient's identity DH key
// (`x3dhSealed`) instead of ridden in the cleartext `x3dh` field — so the gateway,
// which decapsulates the sealed envelope, never sees the initiator's long-term
// identity keys. `recipientIdentityDhPublicKey` comes from the (anonymously
// fetched) bundle, stored on the contact record at ensureSession time.
export function sealedFirstContactEnvelope(
	frame: WsSendFrame,
	pendingHandshake: X3dhHandshakeWire,
	recipientIdentityDhPublicKey: Uint8Array
): WsMessageFrame {
	const sealed = sealBox(recipientIdentityDhPublicKey, utf8ToBytes(JSON.stringify(pendingHandshake)));
	return { ...sealedEnvelopeFromSend(frame), x3dhSealed: bytesToBase64(sealed) };
}

// Trial-decrypt an incoming SEALED (from-less) envelope: try each session we
// hold until one's header key decrypts it — that session identifies the sender.
// Returns null if no session matches (out-of-order or junk → the caller retries).
// PROPAGATES a throw if a session's header matched but the message AEAD failed
// (genuine corruption on the identified session — fail closed, don't keep
// looking). On success the returned session's ratchet is already advanced.
async function trialDecryptSealed(
	username: string,
	frame: WsMessageFrame
): Promise<{ contactUsername: string; session: NonNullable<Awaited<ReturnType<typeof keystore.loadSession>>>; plaintext: Uint8Array } | null> {
	const header = encryptedHeaderFromWire(frame.header);
	const ciphertext = base64ToBytes(frame.ciphertext);
	for (const contactUsername of await keystore.listSessionContacts(username)) {
		const session = await keystore.loadSession(username, contactUsername);
		if (!session) continue;
		const plaintext = tryRatchetDecrypt(session.ratchet, header, ciphertext, session.associatedData);
		if (plaintext) return { contactUsername, session, plaintext };
	}
	return null;
}

// Outcome of handling one inbound envelope. Because the offline queue is
// now at-least-once (deletion is ack-gated), the caller must ack the server
// copy for every *terminal* outcome — 'ok', 'duplicate', and 'failed' — so
// it stops being redelivered. 'retry' is the one non-terminal outcome: a
// message that arrived before the handshake that establishes its session
// (out-of-order flush). It is deliberately NOT acked, so the server keeps
// it and redelivers after the handshake lands.
export type IncomingResult =
	// `sealedReceipt` is set ONLY when a from-less (sealed) message decrypted OK
	// and carried a usable sender token: the caller sends a sealed
	// delivered-receipt back to `sender` using `st` (the sender's own token,
	// fresh from the wrapper), referencing `rid`. Absent on the normal path
	// (that receipt rides the WS ack → server reverse hop, unchanged).
	| { status: 'ok'; displayMessage: DisplayMessage; keyChanged: boolean; sealedReceipt?: { sender: string; st: string; rid: string } }
	// A control payload (e.g. a disappearing-timer change, or a group
	// sender-key distribution) — already applied to the keystore; terminal, so
	// the caller still acks, but there's no message to display.
	// `senderKeyGroupId`/`senderKeySender` are set for a sender-key
	// distribution so the caller can reciprocate (distribute its own key) and,
	// if it's the creator, relay the received key to the rest of the group.
	// `membership` is set for a creator-authoritative membership change so the
	// caller can rotate (on remove) or set up the new member's key (on add).
	| {
			status: 'control';
			keyChanged: boolean;
			senderKeyGroupId?: string;
			senderKeySender?: string;
			membership?: { groupId: string; action: 'add' | 'remove'; target: string; removedMe: boolean };
			// Set when an authorized "delete for everyone" tombstoned a message —
			// the caller mirrors the tombstone into its in-memory view.
			deleteTarget?: { convoKey: string; messageId: string };
	  }
	| { status: 'duplicate' }
	| { status: 'retry' }
	| { status: 'failed'; error: string };

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function identityDiffers(a: IdentityPublicKeys, b: IdentityPublicKeys): boolean {
	return !bytesEqual(a.signingPublicKey, b.signingPublicKey) || !bytesEqual(a.dhPublicKey, b.dhPublicKey);
}

// Handles an inbound WsMessageFrame: dedupes against already-processed ids,
// detects a contact's identity-key change, completes the responder side of
// X3DH for a first (or re-handshake) message, then runs it through the
// ratchet.
export async function decryptIncoming(username: string, frame: WsMessageFrame): Promise<IncomingResult> {
	// Idempotent receive: a redelivered message (ack lost, or reconnect
	// between decrypt and ack) must be recognized and skipped — replaying it
	// into the ratchet fails closed and would otherwise loop forever.
	if (await keystore.isProcessed(username, frame.id)) return { status: 'duplicate' };

	// Resolve the sender and decrypt. Two wire shapes converge here:
	//  - NORMAL: the server stamped `frame.from`; select the session by it.
	//  - SEALED (increment 5): no `from` — trial-decrypt the encrypted header
	//    against each session to identify the sender. Ongoing sealed messages
	//    carry no x3dh; first contact still arrives on the normal path.
	try {
		let contactUsername: string;
		let session: NonNullable<Awaited<ReturnType<typeof keystore.loadSession>>>;
		let plaintext: Uint8Array;
		let keyChanged = false;
		let incomingIdentity: IdentityPublicKeys | null = null;
		let knownContact: Awaited<ReturnType<typeof keystore.getContact>> = null;
		// Set on the first-contact bootstrap path: the authenticated per-message rid
		// used for replay dedup (frame.id is attacker-malleable). Marked at commit.
		let bootstrapRid: string | null = null;
		// The bootstrapped peer's delivery token (from the anti-spoof bundle), saved
		// at commit so OUR replies to them can also be sealed.
		let bootstrapPeerToken: string | null = null;

		if (frame.from !== undefined) {
			contactUsername = frame.from;
			knownContact = await keystore.getContact(username, contactUsername);
			incomingIdentity = frame.x3dh
				? {
						signingPublicKey: base64ToBytes(frame.x3dh.initiatorIdentitySigningPublicKey),
						dhPublicKey: base64ToBytes(frame.x3dh.initiatorIdentityDhPublicKey),
					}
				: null;

			// Key-change detection: a KNOWN contact re-handshaking with a different
			// identity (new device / cleared data / — or a man-in-the-middle). Discard
			// the old session, accept the re-handshake, flag the non-dismissable
			// warning + forced re-verification. Only fires on x3dh (first contact /
			// re-handshake) — never on an ongoing sealed message.
			keyChanged = !!(knownContact && incomingIdentity && identityDiffers(knownContact.identity, incomingIdentity));

			let sess = keyChanged ? null : await keystore.loadSession(username, contactUsername);
			if (!sess) {
				// Out of order: the handshake that establishes this session hasn't
				// arrived. Non-terminal — don't mark processed / ack; redelivered later.
				if (!frame.x3dh || !incomingIdentity) return { status: 'retry' };

				const identity = await keystore.getIdentity(username);
				const signedPreKey = await keystore.getSignedPreKey(username);
				let responderOneTimePreKey;
				if (frame.x3dh.usedOneTimePreKeyPublicKey) {
					const secret = await keystore.takeOneTimePreKeySecret(username, frame.x3dh.usedOneTimePreKeyPublicKey);
					if (secret) {
						responderOneTimePreKey = { keyPair: { publicKey: base64ToBytes(frame.x3dh.usedOneTimePreKeyPublicKey), secretKey: secret } };
					}
				}
				const handshake = respondX3DH({
					responderIdentity: identity,
					responderSignedPreKey: signedPreKey,
					responderOneTimePreKey,
					initiatorIdentityDhPublicKey: base64ToBytes(frame.x3dh.initiatorIdentityDhPublicKey),
					initiatorEphemeralPublicKey: base64ToBytes(frame.x3dh.initiatorEphemeralPublicKey),
				});
				sess = { ratchet: initRatchetAsResponder(handshake.sharedSecret, signedPreKey.keyPair), associatedData: handshake.associatedData };
			}
			plaintext = ratchetDecrypt(sess.ratchet, encryptedHeaderFromWire(frame.header), base64ToBytes(frame.ciphertext), sess.associatedData);
			session = sess;
		} else if (frame.x3dhSealed) {
			// SEALED FIRST-CONTACT BOOTSTRAP (increment 7). The handshake identity is
			// hidden from the gateway in `x3dhSealed` (ECIES to our identity key). We
			// decrypt it, complete X3DH, decrypt the message, learn the sender's
			// CLAIMED username from the wrapper, and VERIFY it against their published
			// bundle — persisting NOTHING until that anti-spoof check passes.
			const identity = await keystore.getIdentity(username);
			const handshakeBytes = openBox(identity.dh.secretKey, base64ToBytes(frame.x3dhSealed));
			if (!handshakeBytes) {
				// Not decryptable by us (corrupt / misrouted) — terminal, ack it away.
				await keystore.markProcessed(username, frame.id);
				return { status: 'failed', error: 'Undecryptable first-contact handshake.' };
			}
			let handshake: X3dhHandshakeWire;
			try {
				handshake = JSON.parse(new TextDecoder().decode(handshakeBytes)) as X3dhHandshakeWire;
			} catch {
				await keystore.markProcessed(username, frame.id);
				return { status: 'failed', error: 'Malformed first-contact handshake.' };
			}
			// Respond to X3DH (anon first-contact has NO one-time prekey, so none is
			// consumed — which also keeps this side effect-free before anti-spoof).
			const signedPreKey = await keystore.getSignedPreKey(username);
			incomingIdentity = {
				signingPublicKey: base64ToBytes(handshake.initiatorIdentitySigningPublicKey),
				dhPublicKey: base64ToBytes(handshake.initiatorIdentityDhPublicKey),
			};
			const responded = respondX3DH({
				responderIdentity: identity,
				responderSignedPreKey: signedPreKey,
				initiatorIdentityDhPublicKey: incomingIdentity.dhPublicKey,
				initiatorEphemeralPublicKey: base64ToBytes(handshake.initiatorEphemeralPublicKey),
			});
			const ratchet = initRatchetAsResponder(responded.sharedSecret, signedPreKey.keyPair);
			let pt: Uint8Array;
			try {
				pt = ratchetDecrypt(ratchet, encryptedHeaderFromWire(frame.header), base64ToBytes(frame.ciphertext), responded.associatedData);
			} catch {
				await keystore.markProcessed(username, frame.id);
				return { status: 'failed', error: 'Failed to decrypt first-contact message.' };
			}
			const unwrapped = unwrapSealed(pt);
			if (!unwrapped || !unwrapped.su) {
				await keystore.markProcessed(username, frame.id);
				return { status: 'failed', error: 'First-contact message missing sender identity.' };
			}
			// Replay dedup on the AUTHENTICATED rid (inside the AEAD) — a replay with a
			// fresh, attacker-chosen frame.id is still caught here.
			if (await keystore.isProcessed(username, unwrapped.rid)) {
				await keystore.markProcessed(username, frame.id);
				return { status: 'duplicate' };
			}
			knownContact = await keystore.getContact(username, unwrapped.su);
			keyChanged = !!(knownContact && identityDiffers(knownContact.identity, incomingIdentity));
			// EXISTING-SESSION GUARD (mirrors the normal path, which never rebuilds a
			// live session for a same-identity known contact). A same-identity bootstrap
			// for a contact we already have a session with is a replay or a redundant
			// re-handshake — NEVER overwrite the live ratchet (a replayed no-OPK
			// first-contact frame would otherwise desync a real conversation once the
			// processed store's rid eventually evicts). Skips anti-spoof too, so a
			// replay can't amplify against the global anon-fetch bucket. A genuine key
			// change (keyChanged) still falls through to anti-spoof + recordKeyChange.
			if (!keyChanged && (await keystore.hasSession(username, unwrapped.su))) {
				await keystore.markProcessed(username, frame.id);
				return { status: 'duplicate' };
			}
			// ANTI-SPOOF: the sender must control the identity keys that the CLAIMED
			// username's published bundle advertises (a successful X3DH decrypt already
			// proved they hold the DH key's private half). Fetch anonymously (don't
			// reveal we're the one checking). Verify-before-commit: nothing persisted above.
			const claimedBundle = await apiFetchBundleAnonymous(unwrapped.su);
			if (claimedBundle.status !== 'ok') {
				// not-found / transport error = transient/ambiguous → retry (don't ack,
				// don't persist) so a temporary failure can't drop a legit first message.
				return { status: 'retry' };
			}
			if (
				claimedBundle.bundle.identityPubkey.dhPublicKey !== handshake.initiatorIdentityDhPublicKey ||
				claimedBundle.bundle.identityPubkey.signingPublicKey !== handshake.initiatorIdentitySigningPublicKey
			) {
				// Name-spoof: the claimed username's real keys ≠ the handshake keys.
				// Reject — ack (clear the queue, no retry) and drop SILENTLY (no contact,
				// no surface, no oracle). Returned as an empty control result. (The DH
				// key is the load-bearing check; the signing key is verified too for
				// safety-number consistency.)
				await keystore.markProcessed(username, frame.id);
				await keystore.markProcessed(username, unwrapped.rid);
				return { status: 'control', keyChanged: false };
			}
			// Verified. Hand off to the shared commit path below (saveSession +
			// addContact/recordKeyChange + payload handling).
			contactUsername = unwrapped.su;
			session = { ratchet, associatedData: responded.associatedData };
			plaintext = pt;
			bootstrapRid = unwrapped.rid;
			bootstrapPeerToken = claimedBundle.bundle.sealToken;
		} else {
			// Sealed: no server-stamped sender. Trial-decrypt against each session —
			// the one whose header key decrypts IS the cryptographically
			// authenticated sender (its ratchet keys are exclusive to that contact).
			const trial = await trialDecryptSealed(username, frame);
			// Nothing matched: an out-of-order follow-on (its predecessor hasn't
			// landed) or junk flushed by a token holder. Non-terminal → retry.
			if (!trial) return { status: 'retry' };
			contactUsername = trial.contactUsername;
			session = trial.session;
			plaintext = trial.plaintext;
			knownContact = await keystore.getContact(username, contactUsername);
		}

		// Unwrap the sealed-sender wrapper (increment 6) to recover the encoded
		// ChatPayload bytes `p`. Applied on BOTH the normal and sealed 1:1 paths
		// (the sender wraps unconditionally); a legacy/unwrapped frame returns null
		// and we decode the bytes as-is. `st`/`rid` are used only to send a sealed
		// delivered-receipt back for a from-less message that decodes to `ok`.
		const wasSealed = frame.from === undefined;
		const unwrapped = unwrapSealed(plaintext);
		const payload = decodeChatPayload(unwrapped ? unwrapped.p : plaintext);
		const sealedReceipt =
			wasSealed && unwrapped && unwrapped.st !== NO_SEAL_TOKEN
				? { sender: contactUsername, st: unwrapped.st, rid: unwrapped.rid }
				: undefined;

		// The ratchet advance is the irreversible step — commit it first, along
		// with contact bookkeeping, before anything payload-specific. See the
		// crash-safety note below on why markProcessed comes last.
		await keystore.saveSession(username, contactUsername, session.ratchet, session.associatedData);
		// Replay-guard the first-contact bootstrap on its authenticated rid, at the
		// commit point (after anti-spoof passed).
		if (bootstrapRid) await keystore.markProcessed(username, bootstrapRid);
		if (keyChanged && incomingIdentity) {
			await keystore.recordKeyChange(username, contactUsername, incomingIdentity);
		} else if (!knownContact && incomingIdentity) {
			await keystore.addContact(username, contactUsername, incomingIdentity);
		}
		// Bootstrapped first contact: persist the peer's delivery token (it rode the
		// anti-spoof bundle) so OUR replies can also be sealed. MUST come after
		// addContact — the store is a no-op for an unknown contact.
		if (bootstrapPeerToken) await keystore.savePeerSealToken(username, contactUsername, bootstrapPeerToken);

		// Control payloads carry no displayable content — apply and return.
		// Still terminal (consumed a ratchet message number), so they're marked
		// processed and the caller acks them.
		if (payload.t === 'timer') {
			await keystore.setDisappearingTimer(username, contactUsername, payload.expiresInSeconds);
			await keystore.markProcessed(username, frame.id);
			return { status: 'control', keyChanged };
		}

		// A contact handing us their current delivery token over our authenticated
		// ratchet. Store it against this contact so a future sealed send can
		// present it. (Keyed by contactUsername = frame.from today; the from-less
		// rework in increment 5 will re-derive the sender from the trial-decrypted
		// session instead.) Control-only — no display, but terminal, so it acks.
		if (payload.t === 'deliverytoken') {
			await keystore.savePeerSealToken(username, contactUsername, payload.token);
			await keystore.markProcessed(username, frame.id);
			return { status: 'control', keyChanged };
		}

		// "Delete for everyone". Authorize STRICTLY: look the target up ONLY in
		// this sender's own conversation, and tombstone it only if the sender
		// authored it (canDelete) — never our messages, never a third party's. An
		// unknown / already-deleted / unauthorized target is a silent no-op that
		// still acks (it rides the same at-least-once queue), never a throw.
		if (payload.t === 'delete') {
			const history = await keystore.loadMessages(username, contactUsername);
			const target = history.find((m) => m.id === payload.targetId);
			let deleteTarget: { convoKey: string; messageId: string } | undefined;
			if (canDelete(target, contactUsername)) {
				const tombstoned = await keystore.tombstoneMessage(username, contactUsername, payload.targetId);
				if (tombstoned) deleteTarget = { convoKey: contactUsername, messageId: payload.targetId };
			}
			await keystore.markProcessed(username, frame.id);
			return { status: 'control', keyChanged, deleteTarget };
		}

		// A sender-key distribution. The group's creator is PINNED on first
		// learn and never rewritable by a later payload — otherwise any member
		// could send a `senderkey` for an existing group with a forged
		// `creator`/`members` and take it over. So:
		//   - existing group: install the sender key only; never touch
		//     metadata (roster/creator changes come solely via the
		//     creator-authoritative `groupmembership` path). And only the
		//     pinned creator may relay keys to a non-creator member (the
		//     creator itself accepts reciprocated keys from members).
		//   - new group: only the claimed creator may bootstrap it for us, and
		//     we must actually be in the roster.
		if (payload.t === 'senderkey') {
			const existing = await keystore.getGroup(username, payload.groupId);
			if (existing) {
				const iAmCreator = existing.creator === username;
				if (!iAmCreator && contactUsername !== existing.creator) {
					await keystore.markProcessed(username, frame.id);
					return { status: 'control', keyChanged }; // only the creator relays to members
				}
			} else {
				if (contactUsername !== payload.group.creator || !payload.group.members.includes(username)) {
					await keystore.markProcessed(username, frame.id);
					return { status: 'control', keyChanged }; // only the creator may invite us
				}
				await keystore.saveGroup(username, {
					id: payload.groupId,
					name: payload.group.name,
					members: payload.group.members,
					creator: payload.group.creator,
				});
			}
			if (payload.sender !== username) {
				await keystore.saveReceiverSenderKey(
					username,
					payload.groupId,
					payload.sender,
					initReceiverSenderKey({
						chainKey: base64ToBytes(payload.distribution.chainKey),
						signPublicKey: base64ToBytes(payload.distribution.signPublicKey),
						iteration: payload.distribution.iteration,
					})
				);
			}
			await keystore.markProcessed(username, frame.id);
			return { status: 'control', keyChanged, senderKeyGroupId: payload.groupId, senderKeySender: payload.sender };
		}

		// A membership change. Creator-authoritative AND only for a group we
		// already know (with a pinned creator) — we never trust a membership
		// payload to declare the creator of an unknown group, and we never let
		// it rewrite name/creator. The bootstrap path is `senderkey` above.
		if (payload.t === 'groupmembership') {
			const existing = await keystore.getGroup(username, payload.groupId);
			if (!existing || contactUsername !== existing.creator) {
				await keystore.markProcessed(username, frame.id);
				return { status: 'control', keyChanged }; // unknown group, or not from its creator
			}

			if (payload.action === 'remove' && payload.target === username) {
				// We were removed — drop all local group state.
				await keystore.deleteGroup(username, payload.groupId);
				await keystore.markProcessed(username, frame.id);
				return {
					status: 'control',
					keyChanged,
					membership: { groupId: payload.groupId, action: 'remove', target: payload.target, removedMe: true },
				};
			}

			// Update the roster only (keep the pinned name/creator).
			await keystore.saveGroup(username, {
				id: existing.id,
				name: existing.name,
				members: payload.group.members,
				creator: existing.creator,
			});
			if (payload.action === 'remove') {
				// A different member was removed — purge their key; the caller
				// rotates our own key and redistributes.
				await keystore.deleteReceiverSenderKey(username, payload.groupId, payload.target);
			}
			await keystore.markProcessed(username, frame.id);
			return {
				status: 'control',
				keyChanged,
				membership: { groupId: payload.groupId, action: payload.action, target: payload.target, removedMe: false },
			};
		}

		const expiresInSeconds = payload.expiresInSeconds;
		const displayMessage: DisplayMessage = {
			id: frame.id,
			from: contactUsername,
			text: payload.t === 'media' ? (payload.caption ?? '') : payload.text,
			ts: displayTsFor(payload.sentAt, frame.ts),
			direction: 'received',
			// Expiry stays on the envelope `ts` on purpose: it's intentionally
			// approximate and must not depend on the sender's clock.
			...(expiresInSeconds ? { expiresAt: frame.ts + expiresInSeconds * 1000 } : {}),
			...(payload.t === 'media' ? { media: payload.media } : {}),
			// Carry the reply quote through from the encrypted payload (display-only).
			...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
		};

		// markProcessed is last: if a crash lands between append and mark, a
		// redelivery replays into the ratchet, which fails closed — but that
		// lands in the catch below, which ALSO marks processed and acks, so
		// the loop is still broken (at the cost of one spurious error toast).
		// Marking before append instead would trade that rare toast for silent
		// message loss, which is worse.
		await keystore.appendMessage(username, contactUsername, displayMessage);
		await keystore.markProcessed(username, frame.id);

		return { status: 'ok', displayMessage, keyChanged, ...(sealedReceipt ? { sealedReceipt } : {}) };
	} catch (err) {
		// AEAD failure is deterministic — this ciphertext will never decrypt,
		// so mark it processed to stop the redelivery loop and let the caller
		// ack it away. (A genuine replay of an already-consumed message would
		// have been caught by the isProcessed check above; reaching here means
		// a first-seen id that won't decrypt — corrupt, tampered, or a
		// post-crash replay.)
		await keystore.markProcessed(username, frame.id);
		return { status: 'failed', error: err instanceof Error ? err.message : 'Failed to decrypt message.' };
	}
}

// ---- sealed sender: delivery tokens ----

// The in-channel payload that hands a contact my current delivery token over
// our authenticated ratchet, so they can reach me on the sender-hidden path.
export function buildDeliveryTokenPayload(token: string): ChatPayload {
	return { t: 'deliverytoken', token };
}

// Get-or-create my own delivery token. Idempotent — returns the existing token
// if I already have one, so calling it on every login is safe. The caller
// registers it with the DO and publishes it in the bundle.
export async function ensureOwnSealToken(username: string): Promise<string> {
	const existing = await keystore.loadOwnSealToken(username);
	if (existing) return existing;
	const token = generateSealToken();
	await keystore.saveOwnSealToken(username, token);
	return token;
}

// Rotate my delivery token: a FRESH token, saved and returned. Used on contact
// removal. Note (stated honestly): because the token also rides my public
// bundle, this is anti-spam / passive-cutoff hygiene, NOT cryptographic access
// control — a determined removed contact can re-fetch my bundle for the new
// token, or send unsealed. The caller re-registers it, re-publishes it, and
// redistributes it to the REMAINING contacts.
export async function rotateOwnSealToken(username: string): Promise<string> {
	const token = generateSealToken();
	await keystore.saveOwnSealToken(username, token);
	return token;
}

// ---- groups (M5) ----

function groupInfo(group: keystore.GroupRecord) {
	return { name: group.name, members: group.members, creator: group.creator };
}

// Builds the distribution payload for OUR OWN sender key (sender = us).
export async function buildSenderKeyDistribution(username: string, groupId: string): Promise<ChatPayload | null> {
	const group = await keystore.getGroup(username, groupId);
	const own = await keystore.loadOwnSenderKey(username, groupId);
	if (!group || !own) return null;
	const dist = senderKeyDistribution(own);
	return {
		t: 'senderkey',
		groupId,
		sender: username,
		group: groupInfo(group),
		distribution: {
			chainKey: bytesToBase64(dist.chainKey),
			signPublicKey: bytesToBase64(dist.signPublicKey),
			iteration: dist.iteration,
		},
	};
}

// Creator-relay: build the distribution payload for ANOTHER member's sender
// key that we hold (as a received key), so the creator can forward it to the
// rest of the group. `sender` is the key's real owner, not us.
export async function buildRelayDistribution(username: string, groupId: string, keyOwner: string): Promise<ChatPayload | null> {
	const group = await keystore.getGroup(username, groupId);
	const received = await keystore.loadReceiverSenderKey(username, groupId, keyOwner);
	if (!group || !received) return null;
	return {
		t: 'senderkey',
		groupId,
		sender: keyOwner,
		group: groupInfo(group),
		distribution: {
			chainKey: bytesToBase64(received.chainKey),
			signPublicKey: bytesToBase64(received.signPublicKey),
			iteration: received.iteration,
		},
	};
}

// Creates a group locally: persist metadata (we are the creator) + generate
// our own sender key. The full roster ALWAYS includes the creator — otherwise
// a member fanning out to "everyone but me" would exclude the creator and
// silently never reach them.
export async function createGroupLocal(username: string, groupId: string, name: string, members: string[]): Promise<void> {
	const roster = [username, ...members.filter((m) => m !== username)];
	await keystore.saveGroup(username, { id: groupId, name, members: roster, creator: username });
	await keystore.saveOwnSenderKey(username, groupId, generateSenderKey());
}

// Ensures we have our own sender key for a group we just learned about (via an
// inbound distribution). Returns true if it was newly created — the caller
// must then distribute it to the other members. Idempotent: never regenerates
// an existing sender key (that would break members who already have it).
export async function ensureOwnSenderKey(username: string, groupId: string): Promise<boolean> {
	if (await keystore.loadOwnSenderKey(username, groupId)) return false;
	await keystore.saveOwnSenderKey(username, groupId, generateSenderKey());
	return true;
}

// Rotates our own sender key: a FRESH key (new chain + new signing keypair).
// This is the security boundary of member removal — after rotation, a removed
// member's retained sender keys are dead. The caller must redistribute the
// new key to the (new) roster.
export async function rotateOwnSenderKey(username: string, groupId: string): Promise<void> {
	await keystore.saveOwnSenderKey(username, groupId, generateSenderKey());
}

// The creator-authoritative membership-change payload, broadcast pairwise.
export function buildMembershipPayload(group: keystore.GroupRecord, action: 'add' | 'remove', target: string): ChatPayload {
	return { t: 'groupmembership', groupId: group.id, group: groupInfo(group), action, target };
}

// Encrypts a group message with our sender key and returns one fan-out frame
// per OTHER member. The associated data is the group id, binding each message
// to its group. Advances (and persists) our sender chain.
export async function groupEncryptForSend(
	username: string,
	groupId: string,
	id: string,
	payload: ChatPayload
): Promise<WsGroupSendFrame[]> {
	const group = await keystore.getGroup(username, groupId);
	const own = await keystore.loadOwnSenderKey(username, groupId);
	if (!group || !own) throw new Error(`No group or sender key for ${groupId}.`);

	const message = senderKeyEncrypt(own, encodeChatPayload(payload), utf8ToBytes(groupId));
	await keystore.saveOwnSenderKey(username, groupId, own);

	const ciphertext = bytesToBase64(message.ciphertext);
	const signature = bytesToBase64(message.signature);
	return group.members
		.filter((m) => m !== username)
		.map((to) => ({ type: 'groupSend', id, to, groupId, iteration: message.iteration, ciphertext, signature }));
}

// Handles an inbound group content message: dedupe, verify the sender's
// signature + decrypt with their sender key, persist to the group's history.
// Returns 'retry' if we don't yet have the sender's sender key (their
// distribution hasn't arrived) — non-terminal, so it's redelivered.
export async function decryptGroupMessage(username: string, frame: WsGroupMessageFrame): Promise<IncomingResult> {
	if (await keystore.isProcessed(username, frame.id)) return { status: 'duplicate' };

	// Roster guard: reject a message from someone not in the current group
	// (e.g. a removed member still posting). Mark processed + return
	// 'duplicate' so the caller acks and silently drops it — NOT 'retry',
	// which would never ack and redeliver forever until the TTL.
	const group = await keystore.getGroup(username, frame.groupId);
	if (group && !group.members.includes(frame.from)) {
		await keystore.markProcessed(username, frame.id);
		return { status: 'duplicate' };
	}

	const receiver = await keystore.loadReceiverSenderKey(username, frame.groupId, frame.from);
	if (!receiver) {
		// The sender's key distribution hasn't arrived yet (it rides a separate
		// pairwise channel). Leave it queued for redelivery.
		return { status: 'retry' };
	}

	try {
		const plaintext = senderKeyDecrypt(
			receiver,
			{ iteration: frame.iteration, ciphertext: base64ToBytes(frame.ciphertext), signature: base64ToBytes(frame.signature) },
			utf8ToBytes(frame.groupId)
		);
		await keystore.saveReceiverSenderKey(username, frame.groupId, frame.from, receiver);

		const payload = decodeChatPayload(plaintext);
		// `payload` isn't narrowed here, so guard the variants that carry `sentAt`.
		const sentAt = payload.t === 'text' || payload.t === 'media' ? payload.sentAt : undefined;
		const displayMessage: DisplayMessage = {
			id: frame.id,
			from: frame.from,
			text: payload.t === 'media' ? (payload.caption ?? '') : payload.t === 'text' ? payload.text : '',
			ts: displayTsFor(sentAt, frame.ts),
			direction: 'received',
			...(payload.t === 'media' ? { media: payload.media } : {}),
			...((payload.t === 'text' || payload.t === 'media') && payload.replyTo ? { replyTo: payload.replyTo } : {}),
		};
		await keystore.appendMessage(username, groupConversationKey(frame.groupId), displayMessage);
		await keystore.markProcessed(username, frame.id);
		return { status: 'ok', displayMessage, keyChanged: false };
	} catch (err) {
		// A signature/AEAD failure is deterministic — mark processed so it's not
		// retried forever, and surface once.
		await keystore.markProcessed(username, frame.id);
		return { status: 'failed', error: err instanceof Error ? err.message : 'Failed to decrypt group message.' };
	}
}

export function groupAckFrame(frame: WsGroupMessageFrame): WsAckFrame {
	return { type: 'ack', messageId: frame.id, to: frame.from };
}
