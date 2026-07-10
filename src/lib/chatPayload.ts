// The plaintext that actually rides the Double Ratchet. The server never
// sees any of this — it's a typed envelope (not raw text) so the encrypted
// channel can carry control messages (disappearing-timer changes) and
// encrypted-media references alongside plain text. Read receipts and typing
// indicators (later milestones) extend this same union: anything "negotiated
// inside the encrypted channel" is a `ChatPayload` variant, never a wire
// field the server could read.

import type { MediaRef, ReplyRef } from '../types';

export type { MediaRef, ReplyRef };

// A sender key distributed pairwise so a member can decrypt this sender's
// group messages (chain key at `iteration`, plus the sender's per-group
// signing public key).
export interface SenderKeyDistributionWire {
	chainKey: string; // base64
	signPublicKey: string; // base64
	iteration: number;
}

// Group metadata carried alongside every distribution so recipients converge
// on the same view of the group (name + full membership + creator).
export interface GroupInfoWire {
	name: string;
	members: string[]; // usernames, including the sender and the recipient
	creator: string; // used by the creator-relay distribution model (v1)
}

export type ChatPayload =
	// `replyTo` (optional) quotes another message — display-only, carried E2EE
	// like everything else. Present on text and media so you can reply to either.
	| { t: 'text'; text: string; expiresInSeconds?: number; replyTo?: ReplyRef }
	| { t: 'media'; media: MediaRef; caption?: string; expiresInSeconds?: number; replyTo?: ReplyRef }
	// A disappearing-messages timer change, negotiated in-channel so both
	// sides' headers stay in sync. 0 = off. Applies going forward only — it
	// never retroactively re-stamps existing messages (Signal's model).
	| { t: 'timer'; expiresInSeconds: number }
	// A group sender-key distribution (M5), sent pairwise over the Double
	// Ratchet — the forward-secret, authenticated bootstrap for group
	// messaging. `sender` is whose sender key this is (may differ from the
	// message's `from` when the creator relays another member's key). Group
	// *content* messages do NOT ride this channel; they're sender-key-encrypted
	// and fanned out as WsGroupSendFrame.
	| { t: 'senderkey'; groupId: string; sender: string; group: GroupInfoWire; distribution: SenderKeyDistributionWire }
	// A group membership change (M5 rekey), broadcast pairwise by the creator
	// only (creator-authoritative). `group` carries the new roster; `target`
	// is who was added/removed. On 'remove', remaining members rotate their
	// sender keys so the removed member's retained keys go dead.
	| { t: 'groupmembership'; groupId: string; group: GroupInfoWire; action: 'add' | 'remove'; target: string }
	// "Delete for everyone" (remote retraction) of a 1:1 message. `targetId` is
	// the message id to tombstone. The RECIPIENT authorizes it — only the
	// message's own author may retract it (see canDelete in deleteAuth.ts) — so
	// a forged delete for someone else's message is a silent no-op.
	| { t: 'delete'; targetId: string }
	// Sealed sender (post-M7): my current delivery token, handed to an existing
	// contact over our authenticated Double Ratchet so they can send to me on
	// the sender-hidden path. Rotated + re-distributed when I remove a contact.
	// The token itself is not a secret (it also rides my public bundle); this
	// channel just delivers it forward-secretly to people I already talk to.
	| { t: 'deliverytoken'; token: string };

// Message-length padding (M7 hardening). The AEAD ciphertext length would
// otherwise track the plaintext length and leak a coarse size signal to the
// server. So every payload is packed into a fixed-size bucket before
// encryption: `[4-byte BE JSON length][utf8(JSON)][zero pad to bucket]`. The
// encoded length depends ONLY on the bucket, not the exact message, so two
// messages that round to the same bucket are indistinguishable by size. This
// is wire-invisible — it rides inside the existing AEAD `ciphertext` for both
// the Double Ratchet (1:1) and sender keys (groups), the single choke point
// where a ChatPayload becomes bytes.
const LENGTH_PREFIX_BYTES = 4;
const SMALL_BUCKETS = [256, 512, 1024, 2048, 4096];
const LARGE_BUCKET_STEP = 4096;

function bucketFor(contentLength: number): number {
	for (const bucket of SMALL_BUCKETS) {
		if (contentLength <= bucket) return bucket;
	}
	return Math.ceil(contentLength / LARGE_BUCKET_STEP) * LARGE_BUCKET_STEP;
}

export function encodeChatPayload(payload: ChatPayload): Uint8Array {
	const json = new TextEncoder().encode(JSON.stringify(payload));
	const total = bucketFor(LENGTH_PREFIX_BYTES + json.length);
	const out = new Uint8Array(total); // zero-filled → the padding is zeros
	// 4-byte big-endian true length, so unpad is exact regardless of the pad.
	out[0] = (json.length >>> 24) & 0xff;
	out[1] = (json.length >>> 16) & 0xff;
	out[2] = (json.length >>> 8) & 0xff;
	out[3] = json.length & 0xff;
	out.set(json, LENGTH_PREFIX_BYTES);
	return out;
}

export function decodeChatPayload(bytes: Uint8Array): ChatPayload {
	// Strip the padding: read the length prefix, slice out the exact JSON.
	if (bytes.length >= LENGTH_PREFIX_BYTES) {
		const len = bytes[0] * 0x1000000 + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
		if (len >= 0 && len <= bytes.length - LENGTH_PREFIX_BYTES) {
			const json = new TextDecoder().decode(bytes.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + len));
			try {
				const parsed = JSON.parse(json) as unknown;
				if (parsed && typeof parsed === 'object' && 't' in parsed) {
					const t = (parsed as { t: unknown }).t;
					if (t === 'text' || t === 'media' || t === 'timer' || t === 'senderkey' || t === 'groupmembership' || t === 'delete' || t === 'deliverytoken') {
						return parsed as ChatPayload;
					}
				}
			} catch {
				// authentic-but-unparseable (version skew / corruption) — fall through
			}
		}
	}
	// The bytes are AEAD-authenticated by the time we get here, so reaching this
	// means a framing/version mismatch, not an attacker. Degrade to empty text
	// rather than crash the message pipeline. (The pre-M4 raw-UTF-8 fallback is
	// gone — there are no legacy unpadded messages.)
	return { t: 'text', text: '' };
}
