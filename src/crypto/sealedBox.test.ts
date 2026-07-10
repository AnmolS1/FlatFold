// Anonymous sealed box (increment 7): the handshake-hiding layer. Confidentiality
// to the recipient's X25519 key, unlinkable ephemeral per message.
import { describe, expect, it } from 'vitest';
import { generateX25519KeyPair } from './primitives';
import { sealBox, openBox } from './sealedBox';

const utf8 = new TextEncoder();

describe('sealed box (anonymous handshake hiding)', () => {
	it('round-trips a plaintext for the intended recipient', () => {
		const recipient = generateX25519KeyPair();
		const msg = utf8.encode('the x3dh handshake');
		const opened = openBox(recipient.secretKey, sealBox(recipient.publicKey, msg));
		expect(opened).not.toBeNull();
		expect(new TextDecoder().decode(opened!)).toBe('the x3dh handshake');
	});

	it('a different recipient key cannot open it', () => {
		const recipient = generateX25519KeyPair();
		const stranger = generateX25519KeyPair();
		const sealed = sealBox(recipient.publicKey, utf8.encode('secret'));
		expect(openBox(stranger.secretKey, sealed)).toBeNull();
	});

	it('a tampered ciphertext fails (AEAD), returning null not a throw', () => {
		const recipient = generateX25519KeyPair();
		const sealed = sealBox(recipient.publicKey, utf8.encode('secret'));
		sealed[sealed.length - 1] ^= 0xff; // flip a ciphertext byte
		expect(openBox(recipient.secretKey, sealed)).toBeNull();
	});

	it('a fresh ephemeral per call makes two seals of the same plaintext differ (unlinkable)', () => {
		const recipient = generateX25519KeyPair();
		const a = sealBox(recipient.publicKey, utf8.encode('same'));
		const b = sealBox(recipient.publicKey, utf8.encode('same'));
		// Different ephemeral prefix → the whole wire blob differs.
		const equal = a.length === b.length && a.every((byte, i) => byte === b[i]);
		expect(equal).toBe(false);
	});

	it('too-short input returns null', () => {
		const recipient = generateX25519KeyPair();
		expect(openBox(recipient.secretKey, new Uint8Array(10))).toBeNull();
	});
});
