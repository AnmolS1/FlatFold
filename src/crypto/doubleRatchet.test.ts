// Signal's Double Ratchet spec (signal.org/docs/specifications/doubleratchet/)
// doesn't publish official numeric test vectors, and the header-encryption
// variant (§5.2) has none either — so this is protocol-level property testing:
// roundtrips, out-of-order and dropped messages, replay resistance, the
// self-healing DH ratchet, AND the header-encryption safety properties
// (per-header nonce uniqueness, opaque headers, transactional decrypt across
// the trial-header-decryption path).
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { generateIdentityKeyPair, generateSignedPreKey, initiateX3DH, respondX3DH } from './x3dh';
import { initRatchetAsInitiator, initRatchetAsResponder, ratchetDecrypt, ratchetEncrypt, tryRatchetDecrypt } from './doubleRatchet';
import type { RatchetState } from './types';

const utf8 = new TextEncoder();
const utf8Decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function setupSession(): { alice: RatchetState; bob: RatchetState; associatedData: Uint8Array } {
	const alice = generateIdentityKeyPair();
	const bob = generateIdentityKeyPair();
	const bobSignedPreKey = generateSignedPreKey(bob);

	const initiatorResult = initiateX3DH({
		initiatorIdentity: alice,
		responderIdentity: { signingPublicKey: bob.signing.publicKey, dhPublicKey: bob.dh.publicKey },
		responderSignedPreKey: { publicKey: bobSignedPreKey.keyPair.publicKey, signature: bobSignedPreKey.signature },
	});
	const responderResult = respondX3DH({
		responderIdentity: bob,
		responderSignedPreKey: bobSignedPreKey,
		initiatorIdentityDhPublicKey: alice.dh.publicKey,
		initiatorEphemeralPublicKey: initiatorResult.ephemeralPublicKey,
	});

	return {
		alice: initRatchetAsInitiator(initiatorResult.sharedSecret, bobSignedPreKey.keyPair.publicKey),
		bob: initRatchetAsResponder(responderResult.sharedSecret, bobSignedPreKey.keyPair),
		associatedData: initiatorResult.associatedData,
	};
}

// Sealed sender relies on trial-decryption: with no `from` on the wire, the
// recipient tries each candidate session and the one whose header key decrypts
// identifies the sender. tryRatchetDecrypt is that primitive.
describe('tryRatchetDecrypt (sealed-sender session identification)', () => {
	it('returns the plaintext and advances state when the header matches this session', () => {
		const { alice, bob, associatedData } = setupSession();
		const { encryptedHeader, ciphertext } = ratchetEncrypt(alice, utf8.encode('sealed hi'), associatedData);
		const out = tryRatchetDecrypt(bob, encryptedHeader, ciphertext, associatedData);
		expect(out && utf8Decode(out)).toBe('sealed hi');
	});

	it('returns null (not throw) for a message that belongs to a DIFFERENT session', () => {
		const a = setupSession();
		const b = setupSession(); // independent keys → different header keys
		const { encryptedHeader, ciphertext } = ratchetEncrypt(a.alice, utf8.encode('for A only'), a.associatedData);
		// Trying a's message against b's receiver: header doesn't decrypt → null.
		expect(tryRatchetDecrypt(b.bob, encryptedHeader, ciphertext, b.associatedData)).toBeNull();
		// And b's receiver is untouched — a's real message still decrypts on a's bob.
		expect(utf8Decode(tryRatchetDecrypt(a.bob, encryptedHeader, ciphertext, a.associatedData)!)).toBe('for A only');
	});

	it('THROWS (fails closed) when the header matches but the message is corrupt — not a wrong-session signal', () => {
		const { alice, bob, associatedData } = setupSession();
		const { encryptedHeader, ciphertext } = ratchetEncrypt(alice, utf8.encode('tamper me'), associatedData);
		const corrupt = new Uint8Array(ciphertext);
		corrupt[corrupt.length - 1] ^= 0x01; // valid header, broken AEAD tag
		expect(() => tryRatchetDecrypt(bob, encryptedHeader, corrupt, associatedData)).toThrow();
	});
});

describe('Double Ratchet (header-encrypted)', () => {
	it('round-trips a single message from the initiator', () => {
		const { alice, bob, associatedData } = setupSession();

		const { encryptedHeader, ciphertext } = ratchetEncrypt(alice, utf8.encode('hello bob'), associatedData);
		const plaintext = ratchetDecrypt(bob, encryptedHeader, ciphertext, associatedData);

		expect(utf8Decode(plaintext)).toBe('hello bob');
	});

	it('the responder cannot send before receiving a first message', () => {
		const { bob, associatedData } = setupSession();
		expect(() => ratchetEncrypt(bob, utf8.encode('too early'), associatedData)).toThrow(/no sending chain/i);
	});

	it('is bidirectional once the responder has received a first message', () => {
		const { alice, bob, associatedData } = setupSession();

		const msg1 = ratchetEncrypt(alice, utf8.encode('hi bob'), associatedData);
		ratchetDecrypt(bob, msg1.encryptedHeader, msg1.ciphertext, associatedData);

		const msg2 = ratchetEncrypt(bob, utf8.encode('hi alice'), associatedData);
		const plaintext = ratchetDecrypt(alice, msg2.encryptedHeader, msg2.ciphertext, associatedData);

		expect(utf8Decode(plaintext)).toBe('hi alice');
	});

	it('decrypts messages delivered out of order within one chain', () => {
		const { alice, bob, associatedData } = setupSession();

		const messages = ['first', 'second', 'third'].map((text) => ratchetEncrypt(alice, utf8.encode(text), associatedData));

		// Deliver 2, then 0, then 1.
		const decrypted = [messages[2], messages[0], messages[1]].map(({ encryptedHeader, ciphertext }) =>
			utf8Decode(ratchetDecrypt(bob, encryptedHeader, ciphertext, associatedData))
		);

		expect(decrypted).toEqual(['third', 'first', 'second']);
	});

	it('tolerates a message that never arrives (dropped, not just late)', () => {
		const { alice, bob, associatedData } = setupSession();

		const messages = ['one', 'two', 'three'].map((text) => ratchetEncrypt(alice, utf8.encode(text), associatedData));

		const first = utf8Decode(ratchetDecrypt(bob, messages[0].encryptedHeader, messages[0].ciphertext, associatedData));
		const third = utf8Decode(ratchetDecrypt(bob, messages[2].encryptedHeader, messages[2].ciphertext, associatedData));

		expect(first).toBe('one');
		expect(third).toBe('three');
	});

	it('recovers after a dropped message even across a DH ratchet step (exercises NHKr trial-decrypt + skip)', () => {
		const { alice, bob, associatedData } = setupSession();

		const aliceMessages = ['a1', 'a2'].map((text) => ratchetEncrypt(alice, utf8.encode(text), associatedData));
		// Bob never receives a1 — only a2 arrives, forcing a DH ratchet + skip.
		expect(utf8Decode(ratchetDecrypt(bob, aliceMessages[1].encryptedHeader, aliceMessages[1].ciphertext, associatedData))).toBe('a2');

		// Bob replies; Alice must still receive it (she must NHKr-trial-decrypt Bob's new header key).
		const bobReply = ratchetEncrypt(bob, utf8.encode('got a2'), associatedData);
		expect(utf8Decode(ratchetDecrypt(alice, bobReply.encryptedHeader, bobReply.ciphertext, associatedData))).toBe('got a2');

		// The dropped a1 arrives very late — its (key, header key) were cached when Bob skipped past it.
		expect(utf8Decode(ratchetDecrypt(bob, aliceMessages[0].encryptedHeader, aliceMessages[0].ciphertext, associatedData))).toBe('a1');
	});

	it('a corrupted message does not wedge the session for the next genuine message (transactional)', () => {
		const { alice, bob, associatedData } = setupSession();

		const m1 = ratchetEncrypt(alice, utf8.encode('m1'), associatedData);
		const m2 = ratchetEncrypt(alice, utf8.encode('m2'), associatedData);
		ratchetDecrypt(bob, m1.encryptedHeader, m1.ciphertext, associatedData);

		const corrupted = new Uint8Array(m2.ciphertext);
		corrupted[0] ^= 0xff;
		expect(() => ratchetDecrypt(bob, m2.encryptedHeader, corrupted, associatedData)).toThrow();

		// The genuine m2 must still decrypt after the corrupted attempt.
		expect(utf8Decode(ratchetDecrypt(bob, m2.encryptedHeader, m2.ciphertext, associatedData))).toBe('m2');
	});

	it('a corrupted skipped-message replay does not evict the real cached key', () => {
		const { alice, bob, associatedData } = setupSession();

		const messages = ['one', 'two', 'three'].map((text) => ratchetEncrypt(alice, utf8.encode(text), associatedData));
		// Deliver "three" first — skips and caches keys for "one" and "two".
		ratchetDecrypt(bob, messages[2].encryptedHeader, messages[2].ciphertext, associatedData);

		const corruptedOne = new Uint8Array(messages[0].ciphertext);
		corruptedOne[0] ^= 0xff;
		expect(() => ratchetDecrypt(bob, messages[0].encryptedHeader, corruptedOne, associatedData)).toThrow();

		// The real "one" must still be decryptable — its cached key wasn't evicted.
		expect(utf8Decode(ratchetDecrypt(bob, messages[0].encryptedHeader, messages[0].ciphertext, associatedData))).toBe('one');
	});

	it('refuses to skip an implausibly large number of message keys', () => {
		const { alice, bob, associatedData } = setupSession();

		ratchetEncrypt(alice, utf8.encode('warmup'), associatedData); // establishes alice's chain
		// Legitimately produce a message claiming a wildly out-of-range N (the header
		// is encrypted, so we can't tamper it post-hoc — advance the sender instead).
		alice.sendMessageNumber = 10_000;
		const farFuture = ratchetEncrypt(alice, utf8.encode('far future'), associatedData);

		expect(() => ratchetDecrypt(bob, farFuture.encryptedHeader, farFuture.ciphertext, associatedData, 50)).toThrow(/implausibly large/i);
	});

	it('fails closed on replay of an already-consumed message', () => {
		const { alice, bob, associatedData } = setupSession();

		const msg = ratchetEncrypt(alice, utf8.encode('once only'), associatedData);
		expect(utf8Decode(ratchetDecrypt(bob, msg.encryptedHeader, msg.ciphertext, associatedData))).toBe('once only');

		const next = ratchetEncrypt(alice, utf8.encode('and another'), associatedData);
		ratchetDecrypt(bob, next.encryptedHeader, next.ciphertext, associatedData);

		expect(() => ratchetDecrypt(bob, msg.encryptedHeader, msg.ciphertext, associatedData)).toThrow();
	});

	it('detects tampering with the encrypted header (fails header decryption)', () => {
		const { alice, bob, associatedData } = setupSession();

		const { encryptedHeader, ciphertext } = ratchetEncrypt(alice, utf8.encode('trust me'), associatedData);
		const tampered = new Uint8Array(encryptedHeader);
		tampered[tampered.length - 1] ^= 0xff; // flip a header-ciphertext byte
		expect(() => ratchetDecrypt(bob, tampered, ciphertext, associatedData)).toThrow(/header decryption failed/i);
	});

	it('self-heals: each DH ratchet step introduces fresh randomness', () => {
		const { alice, bob, associatedData } = setupSession();

		const dhKeypairsSeenByBob = new Set<string>();
		const recordBobDhSelf = () => dhKeypairsSeenByBob.add(bytesToHex(bob.dhSelf.secretKey));
		recordBobDhSelf();

		const conversation: Array<['alice' | 'bob', string]> = [
			['alice', 'r1 alice'],
			['bob', 'r1 bob'],
			['alice', 'r2 alice'],
			['bob', 'r2 bob'],
			['alice', 'r3 alice'],
			['bob', 'r3 bob'],
		];

		for (const [sender, text] of conversation) {
			const senderState = sender === 'alice' ? alice : bob;
			const receiverState = sender === 'alice' ? bob : alice;
			const { encryptedHeader, ciphertext } = ratchetEncrypt(senderState, utf8.encode(text), associatedData);
			expect(utf8Decode(ratchetDecrypt(receiverState, encryptedHeader, ciphertext, associatedData))).toBe(text);
			recordBobDhSelf();
		}

		expect(dhKeypairsSeenByBob.size).toBeGreaterThan(2);
	});
});

describe('header encryption safety properties', () => {
	it('uses a FRESH random nonce per header even though the header key is constant across a chain', () => {
		// This is the footgun: the header key is reused for every message in a
		// sending chain, so a repeated (key, nonce) would be catastrophic. The
		// nonce (first 12 bytes of the encrypted header) must differ every time.
		const { alice, associatedData } = setupSession();
		const nonces = new Set<string>();
		for (let i = 0; i < 25; i++) {
			const { encryptedHeader } = ratchetEncrypt(alice, utf8.encode(`m${i}`), associatedData);
			nonces.add(bytesToHex(encryptedHeader.subarray(0, 12)));
		}
		expect(nonces.size).toBe(25); // all distinct
	});

	it('the encrypted header is opaque — it does not reveal the ratchet DH public key in cleartext', () => {
		const { alice, associatedData } = setupSession();
		const { encryptedHeader } = ratchetEncrypt(alice, utf8.encode('secret structure'), associatedData);
		const dhPubHex = bytesToHex(alice.dhSelf.publicKey);
		const headerHex = bytesToHex(encryptedHeader);
		expect(headerHex.includes(dhPubHex)).toBe(false); // DH pubkey not present in cleartext
	});

	it('a header cannot be decrypted (and so the message fails) without the right header key', () => {
		// Two independent sessions: bob2 has the wrong header keys entirely.
		const s1 = setupSession();
		const s2 = setupSession();
		const { encryptedHeader, ciphertext } = ratchetEncrypt(s1.alice, utf8.encode('for session 1'), s1.associatedData);
		// s2.bob's header keys don't match s1.alice's → header decryption fails.
		expect(() => ratchetDecrypt(s2.bob, encryptedHeader, ciphertext, s1.associatedData)).toThrow();
	});
});

// M1: skipped-key store is bounded across steps with oldest-first eviction.
describe('skipped-message-key store is bounded (M1)', () => {
	it('caps total stored skipped keys and evicts oldest, keeping recent out-of-order decryptable', () => {
		const { alice, bob, associatedData } = setupSession();
		const CAP = 2000; // MAX_SKIPPED_STORED
		// Alice sends 2703 messages on one chain (Bob never replies -> no DH ratchet).
		const msgs = [] as ReturnType<typeof ratchetEncrypt>[];
		for (let i = 0; i <= 2702; i++) msgs.push(ratchetEncrypt(alice, utf8.encode('m' + i), associatedData));

		// Sparse decrypts skip ~900 each into Bob's store; the third pushes past CAP.
		ratchetDecrypt(bob, msgs[900].encryptedHeader, msgs[900].ciphertext, associatedData);
		ratchetDecrypt(bob, msgs[1801].encryptedHeader, msgs[1801].ciphertext, associatedData);
		ratchetDecrypt(bob, msgs[2702].encryptedHeader, msgs[2702].ciphertext, associatedData);

		expect(bob.skippedMessageKeys.size).toBeLessThanOrEqual(CAP);
		// Oldest skipped (message 0) evicted -> undecryptable.
		expect(() => ratchetDecrypt(bob, msgs[0].encryptedHeader, msgs[0].ciphertext, associatedData)).toThrow();
		// A recent skipped message still decrypts out of order.
		expect(utf8Decode(ratchetDecrypt(bob, msgs[2701].encryptedHeader, msgs[2701].ciphertext, associatedData))).toBe('m2701');
	});
});
