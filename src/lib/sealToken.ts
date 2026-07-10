// Sealed-sender delivery token. A random, opaque string that others present to
// the recipient's mailbox to deliver a sender-hidden (sealed) message. It is
// NOT a secret capability — it rides the recipient's (anonymously fetchable)
// prekey bundle, so anyone who can fetch the bundle obtains it. Its purpose is
// anti-spam / per-recipient rate-limit hygiene and cutting off a *passive*
// removed contact after rotation, not cryptographic access control. See
// docs/THREAT_MODEL.md.
//
// The recipient's Mailbox DO holds the authoritative valid set (it validates
// incoming sealed sends against it) and requires length >= 16. 24 random bytes
// → 32 base64 chars clears that with ample margin.
import { randomBytes } from '../crypto/primitives';
import { bytesToBase64 } from '../keystore/codec';

const SEAL_TOKEN_BYTES = 24;

export function generateSealToken(): string {
	return bytesToBase64(randomBytes(SEAL_TOKEN_BYTES));
}
