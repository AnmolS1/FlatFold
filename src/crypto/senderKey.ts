// Sender keys — the group-messaging primitive. Distinct from the pairwise
// Double Ratchet in two ways that must not be conflated:
//
//   1. A group message is encrypted ONCE with a symmetric "sender key" (an
//      HMAC hash-ratchet chain, same construction as the Double Ratchet's
//      per-message chain) and fanned out to every member — not re-encrypted
//      per recipient.
//   2. Because EVERY member holds the sender's chain key, AEAD alone can't
//      prove authorship: any member could forge a message as any other. So
//      every message is ALSO signed with a per-(sender, group) Ed25519 key
//      whose secret only the sender holds, and recipients verify the
//      signature BEFORE deriving a key or decrypting.
//
// The signing key is fresh per (sender, group), NOT the identity key: it
// rotates on rekey, and compromising one group's sender key reveals nothing
// about the sender's other groups or their identity.
//
// Signal publishes no official numeric sender-key test vectors (as with X3DH
// and the Double Ratchet); correctness is established by property and
// adversarial tests (senderKey.test.ts) — forgery rejection, forward
// secrecy, and out-of-order delivery.

import {
	aeadDecrypt,
	aeadEncrypt,
	concatBytes,
	generateEd25519KeyPair,
	hkdfSha256,
	hmacSha256,
	randomBytes,
	sign,
	utf8ToBytes,
	verifySignature,
} from './primitives';
import type { KeyPair } from './types';

const CHAIN_KEY_LENGTH = 32;
const MESSAGE_KEY_CONSTANT = new Uint8Array([0x01]);
const CHAIN_KEY_CONSTANT = new Uint8Array([0x02]);
const MESSAGE_KEY_INFO = utf8ToBytes('FlatFold-SenderKey-MessageKey-v1');
const DEFAULT_MAX_SKIP = 1000;
// M1: total skipped keys retained across steps, oldest-first eviction. Bounds the
// store a peer can grow by advancing without sending (Signal's bounded-store
// semantics). Map preserves insertion order, so the front is the oldest.
const MAX_SKIPPED_STORED = 2000;

// Our own sender key for a group: what we ratchet forward to encrypt.
export interface SenderKeyState {
	chainKey: Uint8Array;
	iteration: number;
	signing: KeyPair; // Ed25519, per-(sender, group)
}

// A peer's sender key for a group: what we ratchet forward to decrypt their
// messages, plus their signing public key to verify authorship.
export interface ReceiverSenderKeyState {
	chainKey: Uint8Array;
	iteration: number;
	signPublicKey: Uint8Array;
	// iteration -> message key, for out-of-order / dropped messages. Bounded
	// by maxSkip so a peer claiming a huge iteration can't force unbounded work.
	skippedMessageKeys: Map<number, Uint8Array>;
}

// The material distributed pairwise (over the Double Ratchet) so a member can
// decrypt this sender's group messages: the chain key AT a given iteration,
// the signing public key, and that iteration.
export interface SenderKeyDistribution {
	chainKey: Uint8Array;
	signPublicKey: Uint8Array;
	iteration: number;
}

export interface SenderKeyMessage {
	iteration: number;
	ciphertext: Uint8Array;
	signature: Uint8Array;
}

function kdfChainKey(chainKey: Uint8Array): { messageKey: Uint8Array; chainKey: Uint8Array } {
	return {
		messageKey: hmacSha256(chainKey, MESSAGE_KEY_CONSTANT),
		chainKey: hmacSha256(chainKey, CHAIN_KEY_CONSTANT),
	};
}

function deriveAeadKeyAndNonce(messageKey: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
	const okm = hkdfSha256(messageKey, undefined, MESSAGE_KEY_INFO, 44);
	return { key: okm.slice(0, 32), nonce: okm.slice(32, 44) };
}

function encodeIteration(iteration: number): Uint8Array {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, iteration, false);
	return bytes;
}

// Signed payload binds the iteration, the ciphertext, and the associated data
// (the group id) — so a signature can't be lifted onto a different message,
// iteration, or group.
function signedData(iteration: number, ciphertext: Uint8Array, associatedData: Uint8Array): Uint8Array {
	return concatBytes(encodeIteration(iteration), ciphertext, associatedData);
}

// Creates a fresh sender key: a random chain key at iteration 0 and a new
// per-(sender, group) Ed25519 signing keypair.
export function generateSenderKey(): SenderKeyState {
	return {
		chainKey: randomBytes(CHAIN_KEY_LENGTH),
		iteration: 0,
		signing: generateEd25519KeyPair(),
	};
}

// The distribution message to send (pairwise) to a member so they can decrypt
// our group messages from `iteration` onward.
export function senderKeyDistribution(state: SenderKeyState): SenderKeyDistribution {
	return { chainKey: state.chainKey, signPublicKey: state.signing.publicKey, iteration: state.iteration };
}

export function initReceiverSenderKey(distribution: SenderKeyDistribution): ReceiverSenderKeyState {
	return {
		chainKey: distribution.chainKey,
		iteration: distribution.iteration,
		signPublicKey: distribution.signPublicKey,
		skippedMessageKeys: new Map(),
	};
}

// Encrypts a group message: advance the hash-ratchet, encrypt, and sign.
// `associatedData` is the group id, bound into both the AEAD and the
// signature.
export function senderKeyEncrypt(state: SenderKeyState, plaintext: Uint8Array, associatedData: Uint8Array): SenderKeyMessage {
	const { messageKey, chainKey } = kdfChainKey(state.chainKey);
	const iteration = state.iteration;
	state.chainKey = chainKey;
	state.iteration = iteration + 1;

	const { key, nonce } = deriveAeadKeyAndNonce(messageKey);
	const ciphertext = aeadEncrypt(key, nonce, plaintext, associatedData);
	const signature = sign(signedData(iteration, ciphertext, associatedData), state.signing.secretKey);

	return { iteration, ciphertext, signature };
}

function messageKeyForIteration(state: ReceiverSenderKeyState, iteration: number, maxSkip: number): Uint8Array {
	// Out-of-order: an already-passed iteration whose key we cached.
	const cached = state.skippedMessageKeys.get(iteration);
	if (cached) {
		state.skippedMessageKeys.delete(iteration);
		return cached;
	}
	if (iteration < state.iteration) {
		throw new Error('Sender-key message is too old (its key was never cached or already consumed).');
	}
	if (iteration - state.iteration > maxSkip) {
		throw new Error('Refusing to skip an implausibly large number of sender-key iterations.');
	}

	// Advance the chain to `iteration`, caching the skipped message keys.
	let chainKey = state.chainKey;
	let current = state.iteration;
	while (current < iteration) {
		const derived = kdfChainKey(chainKey);
		state.skippedMessageKeys.set(current, derived.messageKey);
		chainKey = derived.chainKey;
		current += 1;
	}
	// M1: bound the total store, evicting oldest-first. The oldest skipped messages
	// become undecryptable (dropped), which is the intended tradeoff vs unbounded growth.
	while (state.skippedMessageKeys.size > MAX_SKIPPED_STORED) {
		state.skippedMessageKeys.delete(state.skippedMessageKeys.keys().next().value as number);
	}
	const final = kdfChainKey(chainKey);
	state.chainKey = final.chainKey;
	state.iteration = iteration + 1;
	return final.messageKey;
}

// Decrypts a group message. Verifies the per-sender signature FIRST — an
// unauthenticated message never touches key derivation — then derives the
// message key (advancing/skipping the receiver chain) and decrypts. The
// receiver state is only mutated after the signature verifies.
export function senderKeyDecrypt(
	state: ReceiverSenderKeyState,
	message: SenderKeyMessage,
	associatedData: Uint8Array,
	maxSkip: number = DEFAULT_MAX_SKIP
): Uint8Array {
	if (!verifySignature(message.signature, signedData(message.iteration, message.ciphertext, associatedData), state.signPublicKey)) {
		throw new Error('Sender-key signature verification failed — rejecting forged or corrupted group message.');
	}

	const messageKey = messageKeyForIteration(state, message.iteration, maxSkip);
	const { key, nonce } = deriveAeadKeyAndNonce(messageKey);
	return aeadDecrypt(key, nonce, message.ciphertext, associatedData);
}
