// Encapsulated-response crypto for the sealed anonymous bundle fetch
// (sealed-sender increment 3). Shared by the gateway (worker/seal.ts) and the
// client (src/lib/sealedFetch.ts) so both derive identical keys.
//
// WHY this exists: `@hpke/core` cannot seal a response on the request context —
// RecipientContext.seal() and SenderContext.open() throw NotSupportedError at
// runtime (the TS types wrongly allow them). What both contexts DO expose is a
// working export() (RFC 9180 §5.4). So we build the response AEAD from the HPKE
// *exporter secret*, following the RFC 9458 §4.4 "Encapsulation of Responses"
// construction verbatim (only the export-context label is FlatFold-specific —
// we carry JSON, not bhttp; the KDF structure is the RFC's, pinned, not
// hand-rolled). Each fetch is a fresh single-use HPKE context, so the derived
// key is single-use and GCM nonce reuse is not a practical risk; we keep
// response_nonce anyway for correctness and future third-party-relay compat.
//
// RFC 9458 §4.4:
//   secret        = context.Export("message/bhttp response", max(Nn, Nk))
//   response_nonce = random(max(Nn, Nk))
//   salt          = concat(enc, response_nonce)
//   prk           = Extract(salt, secret)
//   aead_key      = Expand(prk, "key",   Nk)
//   aead_nonce    = Expand(prk, "nonce", Nn)
//   ct            = Seal(aead_key, aead_nonce, "", response)
//   enc_response  = concat(response_nonce, ct)

import { expand, extract } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

// AES-128-GCM (the gateway suite's AEAD): key 16 bytes, nonce 12 bytes.
const Nk = 16;
const Nn = 12;

// The exporter-secret length + response_nonce length are max(Nn, Nk) per the RFC.
export const SEALED_RESPONSE_EXPORT_LENGTH = Math.max(Nn, Nk); // 16
// FlatFold-specific export context label (both ends must match). We seal JSON,
// not bhttp, so the RFC's "message/bhttp response" label is not required.
export const SEALED_RESPONSE_EXPORT_LABEL = 'flatfold sealed-response v1';

// Fixed padded size for the sealed plaintext, so a real bundle and a "not found"
// sentinel are byte-length-indistinguishable to a relay/network observer (the
// bundle values would otherwise identify the lookup target by size). Bundle JSON
// is a few hundred bytes; 1024 leaves ample headroom.
const PADDED_SIZE = 1024;
const LENGTH_PREFIX_BYTES = 4;

// [4-byte BE true length][utf8 bytes][zero pad to PADDED_SIZE]. Same idea as
// src/lib/chatPayload.ts, kept local so this module has no app-layer deps.
function pad(plaintext: Uint8Array): Uint8Array {
	if (plaintext.length + LENGTH_PREFIX_BYTES > PADDED_SIZE) {
		throw new Error('sealed response plaintext exceeds the padded size');
	}
	const out = new Uint8Array(PADDED_SIZE);
	out[0] = (plaintext.length >>> 24) & 0xff;
	out[1] = (plaintext.length >>> 16) & 0xff;
	out[2] = (plaintext.length >>> 8) & 0xff;
	out[3] = plaintext.length & 0xff;
	out.set(plaintext, LENGTH_PREFIX_BYTES);
	return out;
}

function unpad(padded: Uint8Array): Uint8Array {
	const len = padded[0] * 0x1000000 + (padded[1] << 16) + (padded[2] << 8) + padded[3];
	if (len < 0 || len > padded.length - LENGTH_PREFIX_BYTES) throw new Error('malformed sealed response padding');
	return padded.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + len);
}

function deriveKeyNonce(secret: Uint8Array, enc: Uint8Array, responseNonce: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
	const salt = concatBytes(enc, responseNonce);
	const prk = extract(sha256, secret, salt);
	return {
		key: expand(sha256, prk, utf8ToBytes('key'), Nk),
		nonce: expand(sha256, prk, utf8ToBytes('nonce'), Nn),
	};
}

async function aesGcmSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
	const k = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt']);
	return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, k, plaintext as BufferSource));
}

async function aesGcmOpen(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
	const k = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['decrypt']);
	return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, k, ciphertext as BufferSource));
}

// Gateway side. `secret` = HPKE recipient context exporter secret; `enc` = the
// request's encapsulated key. Returns `response_nonce || ciphertext`.
export async function sealResponse(secret: Uint8Array, enc: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
	const responseNonce = randomBytes(SEALED_RESPONSE_EXPORT_LENGTH);
	const { key, nonce } = deriveKeyNonce(secret, enc, responseNonce);
	const ct = await aesGcmSeal(key, nonce, pad(plaintext));
	return concatBytes(responseNonce, ct);
}

// Client side. `secret` = HPKE sender context exporter secret (identical to the
// gateway's for the same context+label+length); `enc` = the client's own
// `sender.enc`. Throws if the AEAD tag fails (tampered / wrong key).
export async function openResponse(secret: Uint8Array, enc: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
	if (blob.length < SEALED_RESPONSE_EXPORT_LENGTH) throw new Error('sealed response too short');
	const responseNonce = blob.subarray(0, SEALED_RESPONSE_EXPORT_LENGTH);
	const ciphertext = blob.subarray(SEALED_RESPONSE_EXPORT_LENGTH);
	const { key, nonce } = deriveKeyNonce(secret, enc, responseNonce);
	return unpad(await aesGcmOpen(key, nonce, ciphertext));
}
