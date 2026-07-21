// Client-side media encryption. A blob is encrypted with a fresh random
// ChaCha20-Poly1305 key + nonce; only the CIPHERTEXT is uploaded to R2, and
// the key/nonce/digest travel inside the E2EE message (as a MediaRef) — the
// server never sees a key. The digest (SHA-256 of the ciphertext) is checked
// before decryption, so a swapped or corrupted R2 object fails closed instead
// of feeding garbage into the AEAD.

import { aeadDecrypt, aeadEncrypt, randomBytes, sha256Hash } from '../crypto/primitives';
import { base64ToBytes, bytesToBase64 } from '../keystore/codec';
import { apiFetch } from './apiClient';
import type { MediaRef } from '../types';

const KEY_LENGTH = 32;
const NONCE_LENGTH = 12;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

export interface MediaUploadInput {
	bytes: Uint8Array;
	mimeType: string;
	mediaKind: MediaRef['mediaKind'];
	name?: string;
	durationMs?: number;
}

// Encrypts `input`, uploads the ciphertext, and returns the MediaRef to embed
// in the outgoing E2EE message.
export async function encryptAndUploadMedia(input: MediaUploadInput): Promise<MediaRef> {
	const key = randomBytes(KEY_LENGTH);
	const nonce = randomBytes(NONCE_LENGTH);
	const ciphertext = aeadEncrypt(key, nonce, input.bytes);
	const digest = sha256Hash(ciphertext);

	const response = await apiFetch('/api/media', {
		method: 'POST',
		headers: { 'Content-Type': 'application/octet-stream' },
		// Copy into a fresh ArrayBuffer so we hand fetch a plain BufferSource,
		// never a SharedArrayBuffer-backed view.
		body: ciphertext.slice().buffer,
	});
	if (!response.ok) throw new Error('Failed to upload attachment.');
	const { id } = (await response.json()) as { id: string };

	return {
		id,
		key: bytesToBase64(key),
		nonce: bytesToBase64(nonce),
		digest: bytesToBase64(digest),
		mediaKind: input.mediaKind,
		mimeType: input.mimeType,
		size: ciphertext.length,
		...(input.name ? { name: input.name } : {}),
		...(input.durationMs ? { durationMs: input.durationMs } : {}),
	};
}

// Downloads, verifies, and decrypts the ciphertext referenced by `ref`.
// Throws if the object is gone or the digest doesn't match (fail closed).
export async function downloadAndDecryptMedia(ref: MediaRef): Promise<Uint8Array> {
	const response = await apiFetch(`/api/media/${encodeURIComponent(ref.id)}`);
	if (!response.ok) throw new Error('Attachment is no longer available.');
	const ciphertext = new Uint8Array(await response.arrayBuffer());

	if (!bytesEqual(sha256Hash(ciphertext), base64ToBytes(ref.digest))) {
		throw new Error('Attachment failed integrity check — refusing to decrypt.');
	}

	return aeadDecrypt(base64ToBytes(ref.key), base64ToBytes(ref.nonce), ciphertext);
}

// Fetch-ack deletion: once a recipient has the plaintext, the server copy can
// go. Best-effort — a failure just leaves it for the deploy-time TTL sweep.
export async function ackMediaFetched(id: string): Promise<void> {
	try {
		await apiFetch(`/api/media/${encodeURIComponent(id)}`, { method: 'DELETE' });
	} catch {
		/* ignore — TTL will reap it */
	}
}
