// Anonymous sealed box (sealed-sender increment 7): encrypt to a recipient's
// long-term X25519 public key WITHOUT revealing the sender. A fresh ephemeral
// keypair per call means the wire carries only `eph_pub || ciphertext` — the
// ephemeral is unlinkable across messages and the sender's identity never
// appears. Used to hide the X3DH first-contact handshake (which carries the
// initiator's long-term identity keys) from the gateway, which would otherwise
// see those keys in cleartext after decapsulating the sealed envelope.
//
// This is confidentiality to the recipient only — it does NOT authenticate the
// sender (anyone can encrypt to a public key). Sender authentication for
// first-contact comes separately, from the X3DH handshake inside + the claimed
// username bound in the ratchet wrapper (see sealedWrap.ts / decryptIncoming).
//
// No forward secrecy: it targets the recipient's long-lived identity key. That is
// acceptable here because it only hides identity keys that are already public in
// the recipient's/sender's bundles; message-content FS still comes from X3DH +
// the Double Ratchet.
import {
	AEAD_KEY_LENGTH,
	AEAD_NONCE_LENGTH,
	X25519_PUBLIC_KEY_LENGTH,
	aeadDecrypt,
	aeadEncrypt,
	concatBytes,
	generateX25519KeyPair,
	hkdfSha256,
	utf8ToBytes,
	x25519SharedSecret,
} from './primitives';

const INFO = utf8ToBytes('flatfold sealed-box v1');

function deriveKeyNonce(sharedSecret: Uint8Array, ephemeralPublicKey: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
	// salt = ephemeral public key (public, per-message unique); the secrecy is in
	// the shared secret. Derive key+nonce together so the fixed nonce is safe (the
	// key is unique per ephemeral).
	const okm = hkdfSha256(sharedSecret, ephemeralPublicKey, INFO, AEAD_KEY_LENGTH + AEAD_NONCE_LENGTH);
	return { key: okm.slice(0, AEAD_KEY_LENGTH), nonce: okm.slice(AEAD_KEY_LENGTH) };
}

export function sealBox(recipientPublicKey: Uint8Array, plaintext: Uint8Array): Uint8Array {
	const ephemeral = generateX25519KeyPair();
	const sharedSecret = x25519SharedSecret(ephemeral.secretKey, recipientPublicKey);
	const { key, nonce } = deriveKeyNonce(sharedSecret, ephemeral.publicKey);
	// AD = the ephemeral public key, binding it to the ciphertext.
	const ciphertext = aeadEncrypt(key, nonce, plaintext, ephemeral.publicKey);
	return concatBytes(ephemeral.publicKey, ciphertext);
}

export function openBox(recipientSecretKey: Uint8Array, sealed: Uint8Array): Uint8Array | null {
	if (sealed.length < X25519_PUBLIC_KEY_LENGTH) return null;
	const ephemeralPublicKey = sealed.slice(0, X25519_PUBLIC_KEY_LENGTH);
	const ciphertext = sealed.slice(X25519_PUBLIC_KEY_LENGTH);
	try {
		const sharedSecret = x25519SharedSecret(recipientSecretKey, ephemeralPublicKey);
		const { key, nonce } = deriveKeyNonce(sharedSecret, ephemeralPublicKey);
		return aeadDecrypt(key, nonce, ciphertext, ephemeralPublicKey);
	} catch {
		// Wrong recipient key, corrupt/tampered ciphertext, or a bad ephemeral
		// point (x25519SharedSecret rejects low-order points) → not for us.
		return null;
	}
}
