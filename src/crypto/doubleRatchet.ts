// Double Ratchet WITH HEADER ENCRYPTION —
// signal.org/docs/specifications/doubleratchet/ §5.2.
//
// Implements the spec's KDF_RK_HE / RatchetEncryptHE / RatchetDecryptHE /
// DecryptHeader / TrySkippedMessageKeysHE / SkipMessageKeysHE / DHRatchetHE
// pseudocode directly. On top of the plain Double Ratchet (out-of-order and
// dropped-message tolerance via a bounded skipped-key cache; post-compromise
// self-healing via the DH ratchet), the message HEADER (sender ratchet pubkey,
// PN, N) is itself AEAD-encrypted under a per-chain header key, so it is opaque
// on the wire. The server can no longer read the ratchet structure — which is
// also what lets sealed sender (which strips from/to) actually hide the
// conversation: without header encryption the cleartext DH pubkey would remain
// a correlation handle.
//
// Two safety properties preserved from the plain variant:
//  - Nonce uniqueness: the message key is fresh per message; the HEADER key is
//    constant across a whole sending chain, so header encryption uses a FRESH
//    RANDOM nonce per header (never deterministic) — a repeated (key,nonce)
//    with ChaCha20-Poly1305 would be catastrophic.
//  - Transactional decrypt: all trial work (header trial-decryption, skip,
//    DH ratchet, chain advance) happens on a clone; the real state is mutated
//    only after both the header AND the message AEAD verify.

import {
	aeadDecrypt,
	aeadEncrypt,
	concatBytes,
	generateX25519KeyPair,
	hkdfSha256,
	hmacSha256,
	randomBytes,
	utf8ToBytes,
	x25519SharedSecret,
} from './primitives';
import type { KeyPair, RatchetEncryptResult, RatchetHeader, RatchetState, SkippedMessageKey } from './types';

const ROOT_HE_INFO = utf8ToBytes('FlatFold-DR-RootHE-v1'); // KDF_RK_HE → root, chain, next header key
const MESSAGE_KEY_INFO = utf8ToBytes('FlatFold-DR-MessageKey-v1');
const SHARED_HEADER_KEY_A_INFO = utf8ToBytes('FlatFold-DR-SharedHeaderKeyA-v1');
const SHARED_HEADER_KEY_B_INFO = utf8ToBytes('FlatFold-DR-SharedHeaderKeyB-v1');
const CHAIN_KEY_CONSTANT = new Uint8Array([0x02]);
const MESSAGE_KEY_CONSTANT = new Uint8Array([0x01]);

const HEADER_NONCE_LENGTH = 12;
const DH_PUBLIC_KEY_LENGTH = 32;
const ENCODED_HEADER_LENGTH = DH_PUBLIC_KEY_LENGTH + 4 + 4; // dhPubkey | PN(u32) | N(u32)

// Signal's own clients cap this in the low thousands; the bound exists so a
// malicious/buggy peer claiming a huge message number can't force unbounded
// key derivation.
const DEFAULT_MAX_SKIP = 1000;
// M1: total skipped keys retained across ratchet steps, oldest-first eviction.
// Bounds the store a peer can grow by advancing without sending the skipped
// messages (Signal's bounded-store semantics). Map preserves insertion order.
const MAX_SKIPPED_STORED = 2000;

// KDF_RK_HE: three 32-byte outputs (root key, chain key, next header key).
function kdfRootKeyHE(rootKey: Uint8Array, dhOutput: Uint8Array): { rootKey: Uint8Array; chainKey: Uint8Array; nextHeaderKey: Uint8Array } {
	const okm = hkdfSha256(dhOutput, rootKey, ROOT_HE_INFO, 96);
	return { rootKey: okm.slice(0, 32), chainKey: okm.slice(32, 64), nextHeaderKey: okm.slice(64, 96) };
}

// The two initial shared header keys (shared_hka, shared_nhkb) that Signal's
// RatchetInit*HE take as inputs — derived deterministically from the X3DH
// shared secret with distinct, domain-separated HKDF labels so both sides
// agree on them without any extra handshake.
function deriveSharedHeaderKeys(sharedSecret: Uint8Array): { sharedHkA: Uint8Array; sharedNhkB: Uint8Array } {
	return {
		sharedHkA: hkdfSha256(sharedSecret, undefined, SHARED_HEADER_KEY_A_INFO, 32),
		sharedNhkB: hkdfSha256(sharedSecret, undefined, SHARED_HEADER_KEY_B_INFO, 32),
	};
}

function kdfChainKey(chainKey: Uint8Array): { chainKey: Uint8Array; messageKey: Uint8Array } {
	return {
		messageKey: hmacSha256(chainKey, MESSAGE_KEY_CONSTANT),
		chainKey: hmacSha256(chainKey, CHAIN_KEY_CONSTANT),
	};
}

function deriveAeadKeyAndNonce(messageKey: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
	const okm = hkdfSha256(messageKey, undefined, MESSAGE_KEY_INFO, 44);
	return { key: okm.slice(0, 32), nonce: okm.slice(32, 44) };
}

function encodeUint32BE(value: number): Uint8Array {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value, false);
	return bytes;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
	return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function encodeHeader(header: RatchetHeader): Uint8Array {
	return concatBytes(header.dhPublicKey, encodeUint32BE(header.previousChainLength), encodeUint32BE(header.messageNumber));
}

function decodeHeader(bytes: Uint8Array): RatchetHeader | null {
	if (bytes.length !== ENCODED_HEADER_LENGTH) return null;
	return {
		dhPublicKey: bytes.slice(0, DH_PUBLIC_KEY_LENGTH),
		previousChainLength: readUint32BE(bytes, DH_PUBLIC_KEY_LENGTH),
		messageNumber: readUint32BE(bytes, DH_PUBLIC_KEY_LENGTH + 4),
	};
}

// HENCRYPT — encrypt a header under the header key with a FRESH RANDOM nonce
// (prepended), since the header key is reused across the whole chain.
function encryptHeader(headerKey: Uint8Array, header: RatchetHeader): Uint8Array {
	const nonce = randomBytes(HEADER_NONCE_LENGTH);
	const ciphertext = aeadEncrypt(headerKey, nonce, encodeHeader(header));
	return concatBytes(nonce, ciphertext);
}

// HDECRYPT — try to decrypt an encrypted header under a header key. Returns
// null (never throws) on a wrong/absent key or malformed input, so the caller
// can try the next candidate key. Read-only: mutates nothing.
function decryptHeaderWith(headerKey: Uint8Array | null, encryptedHeader: Uint8Array): RatchetHeader | null {
	if (!headerKey || encryptedHeader.length <= HEADER_NONCE_LENGTH) return null;
	const nonce = encryptedHeader.subarray(0, HEADER_NONCE_LENGTH);
	const ciphertext = encryptedHeader.subarray(HEADER_NONCE_LENGTH);
	try {
		return decodeHeader(aeadDecrypt(headerKey, nonce, ciphertext));
	} catch {
		return null;
	}
}

function skippedKeyCacheKey(headerKey: Uint8Array, messageNumber: number): string {
	let hex = '';
	for (const byte of headerKey) hex += byte.toString(16).padStart(2, '0');
	return `${hex}:${messageNumber}`;
}

/**
 * Alice's side (RatchetInitAliceHE): she initiates, generates a fresh ratchet
 * keypair, and treats Bob's signed prekey (authenticated by X3DH) as his
 * initial ratchet public key. HKs = shared_hka, NHKr = shared_nhkb, HKr = none.
 */
export function initRatchetAsInitiator(sharedSecret: Uint8Array, responderInitialPublicKey: Uint8Array): RatchetState {
	const dhSelf = generateX25519KeyPair();
	const dhOutput = x25519SharedSecret(dhSelf.secretKey, responderInitialPublicKey);
	const { rootKey, chainKey, nextHeaderKey } = kdfRootKeyHE(sharedSecret, dhOutput);
	const { sharedHkA, sharedNhkB } = deriveSharedHeaderKeys(sharedSecret);

	return {
		rootKey,
		dhSelf,
		dhRemotePublicKey: responderInitialPublicKey,
		sendingChainKey: chainKey,
		receivingChainKey: null,
		sendHeaderKey: sharedHkA, // HKs
		receiveHeaderKey: null, // HKr
		nextSendHeaderKey: nextHeaderKey, // NHKs
		nextReceiveHeaderKey: sharedNhkB, // NHKr
		sendMessageNumber: 0,
		receiveMessageNumber: 0,
		previousSendingChainLength: 0,
		skippedMessageKeys: new Map(),
	};
}

/**
 * Bob's side (RatchetInitBobHE): no sending chain until he processes Alice's
 * first message and DH-ratchets. HKs/HKr = none; NHKs = shared_nhkb;
 * NHKr = shared_hka. Alice's first message decrypts via his NHKr (= shared_hka),
 * which flags the first DH ratchet.
 */
export function initRatchetAsResponder(sharedSecret: Uint8Array, signedPreKeyPair: KeyPair): RatchetState {
	const { sharedHkA, sharedNhkB } = deriveSharedHeaderKeys(sharedSecret);
	return {
		rootKey: sharedSecret,
		dhSelf: signedPreKeyPair,
		dhRemotePublicKey: null,
		sendingChainKey: null,
		receivingChainKey: null,
		sendHeaderKey: null, // HKs
		receiveHeaderKey: null, // HKr
		nextSendHeaderKey: sharedNhkB, // NHKs
		nextReceiveHeaderKey: sharedHkA, // NHKr
		sendMessageNumber: 0,
		receiveMessageNumber: 0,
		previousSendingChainLength: 0,
		skippedMessageKeys: new Map(),
	};
}

export function ratchetEncrypt(state: RatchetState, plaintext: Uint8Array, associatedData: Uint8Array): RatchetEncryptResult {
	if (!state.sendingChainKey || !state.sendHeaderKey) {
		throw new Error('No sending chain yet — the responder must process an incoming message before it can send.');
	}

	const { chainKey, messageKey } = kdfChainKey(state.sendingChainKey);
	state.sendingChainKey = chainKey;

	const header: RatchetHeader = {
		dhPublicKey: state.dhSelf.publicKey,
		previousChainLength: state.previousSendingChainLength,
		messageNumber: state.sendMessageNumber,
	};
	const encryptedHeader = encryptHeader(state.sendHeaderKey, header);
	state.sendMessageNumber += 1;

	const { key, nonce } = deriveAeadKeyAndNonce(messageKey);
	// Bind the encrypted header into the message AEAD (AD = associatedData ||
	// enc_header), so tampering with the header breaks message decryption.
	const ciphertext = aeadEncrypt(key, nonce, plaintext, concatBytes(associatedData, encryptedHeader));

	return { encryptedHeader, ciphertext };
}

function cloneState(state: RatchetState): RatchetState {
	return { ...state, skippedMessageKeys: new Map(state.skippedMessageKeys) };
}

function commitState(target: RatchetState, source: RatchetState): void {
	Object.assign(target, source);
}

// TrySkippedMessageKeysHE: for each cached skipped key, trial-decrypt the
// incoming header with that key's header key; a match (and message number)
// means this is that skipped message. Read/verify-then-mutate: the cached key
// is only evicted after the message AEAD verifies.
function trySkippedMessageKeys(
	state: RatchetState,
	encryptedHeader: Uint8Array,
	ciphertext: Uint8Array,
	associatedData: Uint8Array
): Uint8Array | null {
	for (const [cacheKey, skipped] of state.skippedMessageKeys) {
		const header = decryptHeaderWith(skipped.headerKey, encryptedHeader);
		if (!header || header.messageNumber !== skipped.messageNumber) continue;

		const { key, nonce } = deriveAeadKeyAndNonce(skipped.messageKey);
		const plaintext = aeadDecrypt(key, nonce, ciphertext, concatBytes(associatedData, encryptedHeader));
		state.skippedMessageKeys.delete(cacheKey);
		return plaintext;
	}
	return null;
}

// DecryptHeader: try the current receive header key (same chain), then the
// next one (which flags a DH ratchet step). Read-only.
function decryptHeader(state: RatchetState, encryptedHeader: Uint8Array): { header: RatchetHeader; dhRatchet: boolean } | null {
	const current = decryptHeaderWith(state.receiveHeaderKey, encryptedHeader);
	if (current) return { header: current, dhRatchet: false };
	const next = decryptHeaderWith(state.nextReceiveHeaderKey, encryptedHeader);
	if (next) return { header: next, dhRatchet: true };
	return null;
}

function skipMessageKeys(state: RatchetState, until: number, maxSkip: number): void {
	if (state.receiveMessageNumber + maxSkip < until) {
		throw new Error('Refusing to skip an implausibly large number of message keys.');
	}
	if (!state.receivingChainKey) return;
	if (!state.receiveHeaderKey) throw new Error('Invariant violated: skipping keys with no receive header key.');

	while (state.receiveMessageNumber < until) {
		const { chainKey, messageKey } = kdfChainKey(state.receivingChainKey);
		state.receivingChainKey = chainKey;
		const skipped: SkippedMessageKey = { headerKey: state.receiveHeaderKey, messageKey, messageNumber: state.receiveMessageNumber };
		state.skippedMessageKeys.set(skippedKeyCacheKey(state.receiveHeaderKey, state.receiveMessageNumber), skipped);
		state.receiveMessageNumber += 1;
	}
	// M1: bound the total store, evicting oldest-first. The oldest skipped messages
	// become undecryptable (dropped) — the intended tradeoff vs unbounded growth.
	while (state.skippedMessageKeys.size > MAX_SKIPPED_STORED) {
		state.skippedMessageKeys.delete(state.skippedMessageKeys.keys().next().value as string);
	}
}

// DHRatchetHE: promote the next header keys to current, then derive fresh
// receiving/sending chains and next header keys from the new DH outputs.
function dhRatchetStep(state: RatchetState, header: RatchetHeader): void {
	state.previousSendingChainLength = state.sendMessageNumber;
	state.sendMessageNumber = 0;
	state.receiveMessageNumber = 0;
	state.sendHeaderKey = state.nextSendHeaderKey; // HKs = NHKs
	state.receiveHeaderKey = state.nextReceiveHeaderKey; // HKr = NHKr
	state.dhRemotePublicKey = header.dhPublicKey;

	const receive = kdfRootKeyHE(state.rootKey, x25519SharedSecret(state.dhSelf.secretKey, header.dhPublicKey));
	state.rootKey = receive.rootKey;
	state.receivingChainKey = receive.chainKey;
	state.nextReceiveHeaderKey = receive.nextHeaderKey; // NHKr

	state.dhSelf = generateX25519KeyPair();

	const send = kdfRootKeyHE(state.rootKey, x25519SharedSecret(state.dhSelf.secretKey, header.dhPublicKey));
	state.rootKey = send.rootKey;
	state.sendingChainKey = send.chainKey;
	state.nextSendHeaderKey = send.nextHeaderKey; // NHKs
}

// The header-encrypted decrypt, split so a caller with an UNKNOWN sender (sealed
// sender: no `from` on the wire) can trial-decrypt against each candidate
// session and identify the right one. Returns `null` when the encrypted header
// does not decrypt under this session's header keys — "not this session, try the
// next" — mutating nothing. On a header MATCH it commits the ratchet advance and
// returns the plaintext, and it STILL THROWS if the header matched but the
// message AEAD (or a skipped-key AEAD) fails — that's genuine corruption/tamper
// on the identified session, and must fail closed, never be swallowed as "keep
// looking". So header-decrypt-failure and message-integrity-failure are
// deliberately distinct outcomes.
export function tryRatchetDecrypt(
	state: RatchetState,
	encryptedHeader: Uint8Array,
	ciphertext: Uint8Array,
	associatedData: Uint8Array,
	maxSkip: number = DEFAULT_MAX_SKIP
): Uint8Array | null {
	// Transactional (spec §2.6): all trial work happens on a clone; the real
	// state is committed only after the AEAD tag verifies.
	const trial = cloneState(state);

	// A straggler on an old chain matches only a cached skipped key's header key.
	const skipped = trySkippedMessageKeys(trial, encryptedHeader, ciphertext, associatedData);
	if (skipped) {
		commitState(state, trial);
		return skipped;
	}

	const decrypted = decryptHeader(trial, encryptedHeader);
	if (!decrypted) return null; // header didn't match — not this session
	const { header, dhRatchet } = decrypted;

	if (dhRatchet) {
		skipMessageKeys(trial, header.previousChainLength, maxSkip);
		dhRatchetStep(trial, header);
	}

	skipMessageKeys(trial, header.messageNumber, maxSkip);

	if (!trial.receivingChainKey) throw new Error('Invariant violated: no receiving chain after a DH ratchet step.');
	const { chainKey, messageKey } = kdfChainKey(trial.receivingChainKey);

	const { key, nonce } = deriveAeadKeyAndNonce(messageKey);
	// Header matched → this IS the session. An AEAD failure here is corruption,
	// not a wrong-session signal: aeadDecrypt throws and we let it propagate.
	const plaintext = aeadDecrypt(key, nonce, ciphertext, concatBytes(associatedData, encryptedHeader));

	// Only after the message AEAD verifies: commit the receiving-chain advance.
	trial.receivingChainKey = chainKey;
	trial.receiveMessageNumber = header.messageNumber + 1;
	commitState(state, trial);

	return plaintext;
}

export function ratchetDecrypt(
	state: RatchetState,
	encryptedHeader: Uint8Array,
	ciphertext: Uint8Array,
	associatedData: Uint8Array,
	maxSkip: number = DEFAULT_MAX_SKIP
): Uint8Array {
	const plaintext = tryRatchetDecrypt(state, encryptedHeader, ciphertext, associatedData, maxSkip);
	if (plaintext === null) {
		throw new Error('Header decryption failed — no matching header key (corrupt, tampered, or replayed).');
	}
	return plaintext;
}
