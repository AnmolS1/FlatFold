// Types shared between the client (src/) and the Worker (worker/).
// Kept intentionally minimal in M1 — no session/crypto state yet (that's M2+).

export interface User {
	username: string;
	createdAt: number; // unix seconds
}

export interface AuthContextType {
	username: string | null;
	loading: boolean;
	// True once `username` is known (valid session cookie) but this tab has
	// no cached keystore key yet — a fresh tab, or a device with no local
	// identity at all. See src/contexts/AuthContext.tsx for why unlocking
	// the keystore is a separate step from the server session.
	keystoreLocked: boolean;
	signup: (username: string, password: string) => Promise<void>;
	login: (username: string, password: string) => Promise<void>;
	logout: () => Promise<void>;
	unlockKeystore: (password: string) => Promise<'unlocked' | 'wrong-password'>;
	// Change the account password (D7 §1). Re-wraps the local keystore master key
	// under the new password and rotates the server verifier + session epoch.
	// Resolves 'wrong-password' if the current password is wrong; throws on a
	// server/network failure (the staged local re-wrap is rolled back either way).
	changePassword: (current: string, next: string) => Promise<'ok' | 'wrong-password'>;
}

export interface FormErrors {
	username?: string;
	password?: string;
	general?: string;
}

// A reference to an encrypted attachment stored in R2. The server holds only
// the ciphertext under `id`; everything needed to decrypt it travels inside
// the E2EE payload (see src/lib/chatPayload.ts). Defined here because
// DisplayMessage references it and both are client-only shapes.
export interface MediaRef {
	id: string;
	key: string; // base64 ChaCha20-Poly1305 key
	nonce: string; // base64 AEAD nonce
	digest: string; // base64 SHA-256 of the CIPHERTEXT, verified before decrypt
	mediaKind: 'image' | 'file' | 'voice';
	mimeType: string;
	size: number; // ciphertext byte length
	name?: string;
	durationMs?: number;
}

// A compact quote of the message being replied to, carried inside the E2EE
// payload and shown above the reply bubble. Display-only and
// attacker-controlled (it's the peer's text) — rendered as plain React text,
// never HTML. `text` is a pre-truncated snippet (or a media label).
export interface ReplyRef {
	id: string; // the quoted message's id (lets the UI scroll to it)
	from: string; // who sent the quoted message
	text: string; // snippet
}

// A decrypted message, ready for display — never crosses the wire or
// touches the server; only ciphertext does (see WsSendFrame/WsMessageFrame
// below). Persisted client-side only, in the encrypted local keystore.
export interface DisplayMessage {
	id: string;
	from: string;
	text: string;
	ts: number;
	direction: 'sent' | 'received';
	// Own (direction: 'sent') messages only: 'sent' once handed to the
	// mailbox, upgraded to 'delivered' when a WsDeliveredFrame arrives
	// confirming the recipient acked it. Received messages leave this unset.
	status?: 'sent' | 'delivered';
	// Absolute unix-ms deletion time for a disappearing message. Derived at
	// send/receive from the sender's timestamp + the timer, so both sides
	// expire it at the same wall-clock moment. Unset = never expires.
	expiresAt?: number;
	// Present for attachment messages; the client fetches + decrypts the R2
	// ciphertext referenced here. `text` holds an optional caption.
	media?: MediaRef;
	// Set when this message quotes another (reply). Display-only.
	replyTo?: ReplyRef;
	// Own (direction: 'sent') messages only: the per-message random `rid` that
	// travels inside the ciphertext, so a returning SEALED delivered-receipt
	// (which references `rid`, never the wire id) can be matched back to this
	// message locally — even after a reload (see keystore.findMessageByRid).
	rid?: string;
	// Tombstone: set when the message was retracted via "delete for everyone".
	// The record is kept (so the bubble can render "deleted") but its content
	// is cleared. Distinct from "delete for me", which hard-removes the record.
	deleted?: boolean;
}

// ---- M3: real 1:1 messaging wire format ----
// Ciphertext and key material cross the wire as base64. The server only
// ever sees these opaque strings — decryption happens exclusively in
// ratchetDecrypt on the recipient's device (src/crypto/doubleRatchet.ts).

// Header encryption (M7): the ratchet header (DH pubkey, PN, N) is AEAD-
// encrypted under the sending header key, so on the wire it is a single opaque
// base64 blob (random nonce + ciphertext) — the server can't read the ratchet
// structure.
export interface RatchetHeaderWire {
	encryptedHeader: string; // base64(nonce || AEAD(header))
}

// Present only on the first Double-Ratchet message of a new session — the
// X3DH material the recipient needs to complete the responder side of the
// handshake (signal.org/docs/specifications/x3dh/#sending-the-initial-message).
export interface X3dhHandshakeWire {
	initiatorIdentityDhPublicKey: string;
	// X3DH itself never exchanges signing keys (only the initiator verifies
	// a signature, using a signing key it already got from the bundle
	// fetch) — but the two-separate-keypairs design (src/crypto/types.ts)
	// means the responder has no other way to learn the initiator's signing
	// key for its contact record / future safety-number display. Carried
	// here as plain identity metadata, not a handshake security input.
	initiatorIdentitySigningPublicKey: string;
	initiatorEphemeralPublicKey: string;
	// The public key of the one-time prekey the initiator consumed (from the
	// bundle fetch), if any — tells the responder which of its own OPK
	// secrets to look up and erase.
	usedOneTimePreKeyPublicKey?: string;
}

// Client -> mailbox DO (over its own WebSocket): "deliver this to `to`."
// `id` is client-generated (a random UUID) and travels unchanged through
// the envelope, the recipient's ack, and the delivered notification — so a
// sender can correlate all three back to its own local message. Client-set
// (not server-set) precisely because the sender needs to know the id before
// it ever hears back; it's used only for dedupe/correlation, never as a
// security or ordering input.
export interface WsSendFrame {
	type: 'send';
	id: string;
	to: string;
	ciphertext: string;
	header: RatchetHeaderWire;
	x3dh?: X3dhHandshakeWire;
}

// Client -> its own mailbox DO: "I processed message `messageId`; delete
// the queued copy and tell `to` (the original sender) it was delivered."
// Sent for every message the client reaches a terminal decision on —
// including duplicates and permanently-undecryptable ones — so the server
// copy always gets cleared. See docs/ARCHITECTURE.md on at-least-once +
// idempotent receive.
export interface WsAckFrame {
	type: 'ack';
	messageId: string;
	// The original sender, so the DO can send them a delivered-receipt. ABSENT
	// for a sealed (from-less) message: we don't know who sent it, so the DO just
	// deletes our own queued copy with no reverse hop (and no sender leaks).
	to?: string;
}

// Client -> its own mailbox DO: a group content message to fan out to one
// member's mailbox. Distinct from WsSendFrame — no ratchet header, no x3dh;
// it carries the sender-key ciphertext, the per-sender Ed25519 signature, and
// the chain iteration. The sender emits one of these per OTHER member (the
// same `id`/`groupId`/`iteration`/`ciphertext`/`signature`, different `to`).
export interface WsGroupSendFrame {
	type: 'groupSend';
	id: string;
	to: string;
	groupId: string;
	iteration: number;
	ciphertext: string;
	signature: string;
}

export type WsClientToServerFrame = WsSendFrame | WsAckFrame | WsGroupSendFrame;

// Mailbox DO -> client: an inbound message. `id`/`from` come from the send
// frame; `ts`/`seq` are stamped server-side. `ts` is coarsened to the
// minute (invariant #5) and is a data field; `seq` is a per-sender
// monotonic send-order counter used only to key the offline queue in send
// order (never displayed, never persisted client-side).
export interface WsMessageFrame {
	type: 'message';
	id: string;
	// The sender, stamped server-side on the NORMAL path. ABSENT on a sealed
	// (sender-hidden) message — the point is the server never learns it; the
	// recipient identifies the sender by trial-decrypting the encrypted header
	// against each session (see tryRatchetDecrypt / decryptIncoming).
	from?: string;
	ciphertext: string;
	header: RatchetHeaderWire;
	x3dh?: X3dhHandshakeWire;
	ts: number;
	// Per-sender send-order counter for the offline queue on the NORMAL path.
	// ABSENT on a sealed message (no sender to order by) — the DO queues those in
	// receive order instead (recvSeq). Never displayed, never persisted client-side.
	seq?: number;
	// SEALED FIRST-CONTACT ONLY (increment 7): the X3DH handshake, ECIES-encrypted
	// to the recipient's identity key (base64 of `eph_pub || ciphertext`). Replaces
	// the cleartext `x3dh` on a sealed first send so the gateway never sees the
	// initiator's long-term identity keys. Its PRESENCE marks a first-contact
	// bootstrap on the receive side (see decryptIncoming). Absent on ongoing sealed
	// messages and on the normal path.
	x3dhSealed?: string;
}

// Mailbox DO -> client: "a message you sent was delivered." TWO shapes:
//  - NORMAL path: `{messageId, from}` — the wire id of the delivered message +
//    which conversation, matched directly. Best-effort and live-only: if the
//    sender is offline when the ack propagates, this is dropped, not queued
//    (see docs/ARCHITECTURE.md).
//  - SEALED path (increment 6): `{id, rid}` — no sender identity and no original
//    wire id (either would let a same-operator gateway link sender↔recipient).
//    `rid` is a per-message random carried INSIDE the original ciphertext; the
//    sender matches it to a local message locally. `id` is a fresh random used
//    only to key the reverse envelope in the sender's offline queue (unrelated
//    to the delivered message). Queued (not live-only) so a briefly-offline
//    sender still learns delivery on reconnect.
export interface WsDeliveredFrame {
	type: 'delivered';
	messageId?: string;
	from?: string;
	id?: string;
	rid?: string;
}

// Mailbox DO -> client: an inbound group content message. `from` is the
// sender; the recipient decrypts with `from`'s sender key for `groupId`,
// after verifying `signature`.
export interface WsGroupMessageFrame {
	type: 'groupMessage';
	id: string;
	from: string;
	groupId: string;
	iteration: number;
	ciphertext: string;
	signature: string;
	ts: number;
	seq: number;
}

export type WsServerToClientFrame = WsMessageFrame | WsDeliveredFrame | WsGroupMessageFrame;

// Anything the mailbox queues/delivers: a 1:1 message or a group message.
// Both have id/from/ts/seq, which is all the queue + ack logic needs.
export type WsEnvelope = WsMessageFrame | WsGroupMessageFrame;

export interface IdentityPubkeyWire {
	signingPublicKey: string;
	dhPublicKey: string;
}

export interface SignedPrekeyWire {
	publicKey: string;
	signature: string;
}

export interface PublishKeysRequest {
	identityPubkey: IdentityPubkeyWire;
	signedPrekey: SignedPrekeyWire;
	oneTimePreKeys: string[];
}

export interface PreKeyBundleResponse {
	identityPubkey: IdentityPubkeyWire;
	signedPrekey: SignedPrekeyWire;
	oneTimePreKey: string | null;
	// The contact's current public delivery token, if they've published one, so
	// a first-contact sender can reach them over the sealed path (increment 3+).
	sealToken: string | null;
}
