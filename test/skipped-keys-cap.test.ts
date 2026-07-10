import { describe, expect, it } from 'vitest';
import { generateSenderKey, initReceiverSenderKey, senderKeyDistribution, senderKeyDecrypt, senderKeyEncrypt } from '../src/crypto/senderKey';

// M1: skipped-message-key maps must be bounded in TOTAL (not just per step), with
// oldest-first eviction, so a peer that keeps advancing without sending can't grow
// the map unboundedly in our memory/keystore.
const CAP = 2000; // MAX_SKIPPED_STORED
const AD = new TextEncoder().encode('group-ad');
const pt = (i: number) => new TextEncoder().encode('m' + i);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('sender-key skipped-key store is bounded (M1)', () => {
	it('caps total stored skipped keys and evicts oldest, keeping recent out-of-order decryptable', () => {
		const sender = generateSenderKey();
		const receiver = initReceiverSenderKey(senderKeyDistribution(sender));

		// Capture ciphertexts at every iteration; decrypt only sparse targets so each
		// decrypt skips ~900 keys into the store (900 < per-step maxSkip of 1000).
		const msgs = [] as ReturnType<typeof senderKeyEncrypt>[];
		for (let i = 0; i <= 2702; i++) msgs.push(senderKeyEncrypt(sender, pt(i), AD));

		senderKeyDecrypt(receiver, msgs[900], AD); // skips 0..899
		senderKeyDecrypt(receiver, msgs[1801], AD); // skips 901..1800
		senderKeyDecrypt(receiver, msgs[2702], AD); // skips 1802..2701 -> total > CAP, evicts oldest

		expect(receiver.skippedMessageKeys.size).toBeLessThanOrEqual(CAP);
		// Oldest skipped (iteration 0) was evicted -> its message is no longer decryptable.
		expect(() => senderKeyDecrypt(receiver, msgs[0], AD)).toThrow();
		// A recent skipped iteration is still cached and decrypts out of order.
		expect(text(senderKeyDecrypt(receiver, msgs[2701], AD))).toBe('m2701');
	});
});
