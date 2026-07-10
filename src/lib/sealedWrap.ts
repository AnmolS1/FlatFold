// Sealed-sender 1:1 plaintext wrapper (increment 6). A pure codec, sibling to
// chatPayload.ts — kept free of keystore/IndexedDB deps so it unit-tests in
// isolation.
//
// Every 1:1 ratchet plaintext is wrapped as
//   magic || suLen(1) || su(padded) || st(32) || rid(32) || p
// so a message carries, INSIDE the E2EE ciphertext: the SENDER's claimed
// username `su` (increment 7 — bound to the sender's identity key by the ratchet
// AEAD, which required that key's private half; the receiver's first-contact
// bootstrap trusts `su` only after verifying it against the sender's published
// bundle), the sender's own delivery token `st` (increment 6 — so the recipient
// can send a delivered-receipt back over the sealed path), and a per-message
// random `rid` the receipt references. The receipt references `rid`, NEVER the
// wire id — a receipt keyed by the wire id would let the same-operator gateway
// deterministically link sender↔recipient (see docs/SEALED_SENDER.md "the trap").
// Applied UNCONDITIONALLY on the 1:1 path (increment 5 encrypts ONCE then picks
// transport, so both the sealed and the WS-fallback paths share the single
// ciphertext); groups are never wrapped. The receiver always unwraps to recover
// `p`, and acts on `su`/`st`/`rid` only where relevant (first-contact / from-less).
import { utf8ToBytes } from '../crypto/primitives';
import type { WsDeliveredFrame } from '../types';

// v2: added the `su` field (increment 7). A bare encodeChatPayload frame starts
// with a 0x00 length byte, so neither magic collides with an unwrapped frame.
const SEALED_WRAP_MAGIC = 0x02;
// A seal token is 24 random bytes → exactly 32 base64 chars (see sealToken.ts),
// so `st`/`rid` are fixed-width and need no length prefix.
const SEAL_TOKEN_B64_LEN = 32;
// Usernames are `[a-zA-Z0-9_]{3,32}` (ASCII, ≤32 bytes) — fixed-width padded for
// length-uniformity, with a 1-byte length prefix.
const USERNAME_MAX_LEN = 32;
const SU_FIELD_LEN = 1 + USERNAME_MAX_LEN;
const SEALED_WRAP_HEADER_LEN = 1 + SU_FIELD_LEN + SEAL_TOKEN_B64_LEN * 2;
// Filler when we have no own token yet (control payloads can flow before
// ensureOwnSealToken settles). The recipient sees a non-token `st` that won't
// validate at our DO, so it simply sends no receipt — never a throw.
export const NO_SEAL_TOKEN = '0'.repeat(SEAL_TOKEN_B64_LEN);

export function wrapSealed(su: string, st: string, rid: string, p: Uint8Array): Uint8Array {
	const suBytes = utf8ToBytes(su.length <= USERNAME_MAX_LEN ? su : '');
	const stBytes = utf8ToBytes(st.length === SEAL_TOKEN_B64_LEN ? st : NO_SEAL_TOKEN);
	const ridBytes = utf8ToBytes(rid.length === SEAL_TOKEN_B64_LEN ? rid : NO_SEAL_TOKEN);
	const out = new Uint8Array(SEALED_WRAP_HEADER_LEN + p.length);
	let o = 0;
	out[o++] = SEALED_WRAP_MAGIC;
	out[o++] = suBytes.length; // ≤ 32
	out.set(suBytes, o);
	o += USERNAME_MAX_LEN; // zero-padded remainder
	out.set(stBytes, o);
	o += SEAL_TOKEN_B64_LEN;
	out.set(ridBytes, o);
	o += SEAL_TOKEN_B64_LEN;
	out.set(p, o);
	return out;
}

// Returns null (→ caller falls back to decoding the bytes as-is) for anything
// not carrying our magic — a legacy/unwrapped frame or junk. Degrades exactly
// as the pre-increment-6 path did.
export function unwrapSealed(bytes: Uint8Array): { su: string; st: string; rid: string; p: Uint8Array } | null {
	if (bytes.length < SEALED_WRAP_HEADER_LEN || bytes[0] !== SEALED_WRAP_MAGIC) return null;
	const dec = new TextDecoder();
	let o = 1;
	const suLen = bytes[o++];
	if (suLen > USERNAME_MAX_LEN) return null;
	const su = dec.decode(bytes.subarray(o, o + suLen));
	o += USERNAME_MAX_LEN;
	const st = dec.decode(bytes.subarray(o, o + SEAL_TOKEN_B64_LEN));
	o += SEAL_TOKEN_B64_LEN;
	const rid = dec.decode(bytes.subarray(o, o + SEAL_TOKEN_B64_LEN));
	o += SEAL_TOKEN_B64_LEN;
	return { su, st, rid, p: bytes.subarray(o) };
}

// The from-less reverse hop: a sealed delivered-receipt. Carries only `rid`
// (matched locally by the sender) and a FRESH random `id` used solely to key
// the sender's offline queue — never the original message's wire id, never any
// identity. Sent to the sender via apiSealedSend using the sender's OWN token
// (which travelled in the wrapper, fresh by construction).
export function deliveredReceiptEnvelope(rid: string): WsDeliveredFrame {
	return { type: 'delivered', id: crypto.randomUUID(), rid };
}
