// Shared types for the X3DH + Double Ratchet crypto core. Pure TS, no UI,
// no network, no storage — how this plugs into D1/the mailbox protocol is
// decided in a later milestone. See docs/ARCHITECTURE.md for the running
// account of design tradeoffs.

export interface KeyPair {
	publicKey: Uint8Array;
	secretKey: Uint8Array;
}

// An identity is TWO separate keypairs — X25519 for Diffie-Hellman, Ed25519
// for signing the signed prekey. Signal's real implementation uses a single
// Curve25519 scalar for both roles via XEdDSA (a birational Montgomery <->
// Edwards conversion). We deliberately use two ordinary keypairs instead:
// XEdDSA is a distinct, security-sensitive construction that's easy to get
// subtly wrong, and X3DH's security does not depend on key reuse across
// signing and DH — that's a bandwidth optimization Signal made, not a
// requirement. The cost is a slightly larger identity bundle (two public
// keys instead of one); the benefit is not reimplementing XEdDSA ourselves.
export interface IdentityKeyPair {
	signing: KeyPair; // Ed25519
	dh: KeyPair; // X25519
}

export interface IdentityPublicKeys {
	signingPublicKey: Uint8Array;
	dhPublicKey: Uint8Array;
}

export interface SignedPreKey {
	keyPair: KeyPair; // X25519
	signature: Uint8Array; // Ed25519 signature by the identity signing key, over keyPair.publicKey
}

export interface OneTimePreKey {
	keyPair: KeyPair; // X25519
}

// What a user publishes so others can start a session with them. How this
// gets serialized into D1 / fetched from the mailbox is a later milestone's
// concern.
export interface PreKeyBundle {
	identity: IdentityPublicKeys;
	signedPreKey: {
		publicKey: Uint8Array;
		signature: Uint8Array;
	};
	oneTimePreKey?: Uint8Array;
}

export interface X3DHInitiatorParams {
	initiatorIdentity: IdentityKeyPair;
	responderIdentity: IdentityPublicKeys;
	responderSignedPreKey: { publicKey: Uint8Array; signature: Uint8Array };
	responderOneTimePreKey?: Uint8Array;
}

export interface X3DHInitiatorResult {
	sharedSecret: Uint8Array;
	associatedData: Uint8Array;
	ephemeralPublicKey: Uint8Array;
	usedOneTimePreKey: boolean;
}

export interface X3DHResponderParams {
	responderIdentity: IdentityKeyPair;
	responderSignedPreKey: SignedPreKey;
	responderOneTimePreKey?: OneTimePreKey;
	initiatorIdentityDhPublicKey: Uint8Array;
	initiatorEphemeralPublicKey: Uint8Array;
}

export interface X3DHResponderResult {
	sharedSecret: Uint8Array;
	associatedData: Uint8Array;
}

export interface RatchetHeader {
	dhPublicKey: Uint8Array; // sender's current ratchet public key
	previousChainLength: number; // PN
	messageNumber: number; // N
}

// Header encryption (M7): the header is AEAD-encrypted under the sending
// header key, so `encryptedHeader` (a random-nonce-prefixed blob) is opaque on
// the wire — the server no longer sees the ratchet DH key / message numbers.
export interface RatchetEncryptResult {
	encryptedHeader: Uint8Array;
	ciphertext: Uint8Array;
}

// A skipped message key (out-of-order/dropped). With header encryption the
// cache is keyed by the receive header key that decrypts the skipped header
// (not the DH pubkey, which is no longer visible pre-decrypt), so we retain
// the header key to trial-decrypt candidate headers.
export interface SkippedMessageKey {
	headerKey: Uint8Array;
	messageKey: Uint8Array;
	messageNumber: number;
}

// Internal ratchet state. Exported so callers can persist/restore a session
// into the encrypted keystore. Mutated in place by ratchetEncrypt/
// ratchetDecrypt — callers own the object and its lifetime. The four header
// keys (HKs/HKr/NHKs/NHKr) drive header encryption (Signal's HE variant).
export interface RatchetState {
	rootKey: Uint8Array;
	dhSelf: KeyPair;
	dhRemotePublicKey: Uint8Array | null;
	sendingChainKey: Uint8Array | null;
	receivingChainKey: Uint8Array | null;
	sendHeaderKey: Uint8Array | null; // HKs
	receiveHeaderKey: Uint8Array | null; // HKr
	nextSendHeaderKey: Uint8Array | null; // NHKs
	nextReceiveHeaderKey: Uint8Array | null; // NHKr
	sendMessageNumber: number;
	receiveMessageNumber: number;
	previousSendingChainLength: number;
	skippedMessageKeys: Map<string, SkippedMessageKey>;
}
