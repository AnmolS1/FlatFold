// Sender keys have no official Signal numeric vectors (confirmed — Signal's
// group spec, like X3DH/Double Ratchet, publishes none), so this is
// property + adversarial testing: roundtrips, out-of-order delivery, and the
// three group-specific security properties — forgery rejection, forward
// secrecy, and the DoS skip bound.
import { describe, expect, it } from 'vitest';
import { generateEd25519KeyPair, sign } from './primitives';
import {
	generateSenderKey,
	initReceiverSenderKey,
	senderKeyDecrypt,
	senderKeyDistribution,
	senderKeyEncrypt,
	type SenderKeyMessage,
} from './senderKey';

const GROUP = new TextEncoder().encode('group-abc');
const utf8 = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);

// Mirrors the implementation's signed-data layout (BE iteration || ciphertext
// || associatedData) so the forgery test can build a validly-structured
// signature over the wrong key.
function signedData(iteration: number, ciphertext: Uint8Array, ad: Uint8Array): Uint8Array {
	const iter = new Uint8Array(4);
	new DataView(iter.buffer).setUint32(0, iteration, false);
	return new Uint8Array([...iter, ...ciphertext, ...ad]);
}

describe('sender key', () => {
	it('encrypts and decrypts a group message', () => {
		const sender = generateSenderKey();
		const receiver = initReceiverSenderKey(senderKeyDistribution(sender));

		const msg = senderKeyEncrypt(sender, utf8('hello group'), GROUP);
		expect(str(senderKeyDecrypt(receiver, msg, GROUP))).toBe('hello group');
	});

	it('decrypts a run of messages in order', () => {
		const sender = generateSenderKey();
		const receiver = initReceiverSenderKey(senderKeyDistribution(sender));

		for (let i = 0; i < 5; i++) {
			const msg = senderKeyEncrypt(sender, utf8(`m${i}`), GROUP);
			expect(str(senderKeyDecrypt(receiver, msg, GROUP))).toBe(`m${i}`);
		}
	});

	it('handles out-of-order delivery within a chain', () => {
		const sender = generateSenderKey();
		const receiver = initReceiverSenderKey(senderKeyDistribution(sender));

		const m0 = senderKeyEncrypt(sender, utf8('zero'), GROUP);
		const m1 = senderKeyEncrypt(sender, utf8('one'), GROUP);
		const m2 = senderKeyEncrypt(sender, utf8('two'), GROUP);

		// Deliver 2, then 0, then 1.
		expect(str(senderKeyDecrypt(receiver, m2, GROUP))).toBe('two');
		expect(str(senderKeyDecrypt(receiver, m0, GROUP))).toBe('zero');
		expect(str(senderKeyDecrypt(receiver, m1, GROUP))).toBe('one');
	});

	it('REJECTS a message whose signature was forged by another member', () => {
		// A group member holds the sender's chain key (from distribution) and
		// could produce valid ciphertext — but not a valid signature, since the
		// signing secret is the sender's alone. Simulate by re-signing a real
		// message with a DIFFERENT key.
		const sender = generateSenderKey();
		const receiver = initReceiverSenderKey(senderKeyDistribution(sender));
		const msg = senderKeyEncrypt(sender, utf8('authentic'), GROUP);

		const attackerKey = generateEd25519KeyPair();
		// Re-sign the exact signed data with the attacker's key — a valid
		// signature, but by the wrong signer.
		const forgedSig = sign(signedData(msg.iteration, msg.ciphertext, GROUP), attackerKey.secretKey);
		const forged: SenderKeyMessage = { ...msg, signature: forgedSig };

		expect(() => senderKeyDecrypt(receiver, forged, GROUP)).toThrow(/signature verification failed/i);
	});

	it('REJECTS a message with a stripped/corrupted signature', () => {
		const sender = generateSenderKey();
		const receiver = initReceiverSenderKey(senderKeyDistribution(sender));
		const msg = senderKeyEncrypt(sender, utf8('real'), GROUP);

		const tampered: SenderKeyMessage = { ...msg, signature: new Uint8Array(msg.signature) };
		tampered.signature[0] ^= 0xff;
		expect(() => senderKeyDecrypt(receiver, tampered, GROUP)).toThrow(/signature verification failed/i);
	});

	it('REJECTS tampered ciphertext (the signature covers it)', () => {
		const sender = generateSenderKey();
		const receiver = initReceiverSenderKey(senderKeyDistribution(sender));
		const msg = senderKeyEncrypt(sender, utf8('real'), GROUP);

		const tampered: SenderKeyMessage = { ...msg, ciphertext: new Uint8Array(msg.ciphertext) };
		tampered.ciphertext[0] ^= 0xff;
		expect(() => senderKeyDecrypt(receiver, tampered, GROUP)).toThrow(/signature verification failed/i);
	});

	it('REJECTS a message replayed into a different group (associated data is bound)', () => {
		const sender = generateSenderKey();
		const receiver = initReceiverSenderKey(senderKeyDistribution(sender));
		const msg = senderKeyEncrypt(sender, utf8('for group abc'), GROUP);

		const otherGroup = new TextEncoder().encode('group-xyz');
		expect(() => senderKeyDecrypt(receiver, msg, otherGroup)).toThrow(/signature verification failed/i);
	});

	it('provides forward secrecy — a member joining later cannot read earlier messages', () => {
		const sender = generateSenderKey();
		const earlyReceiver = initReceiverSenderKey(senderKeyDistribution(sender));

		const m0 = senderKeyEncrypt(sender, utf8('secret before you joined'), GROUP);
		expect(str(senderKeyDecrypt(earlyReceiver, m0, GROUP))).toBe('secret before you joined');

		// A member who receives distribution AFTER m0 was sent gets the chain
		// key at the current (advanced) iteration. The chain KDF is one-way, so
		// they cannot roll back to derive m0's key — decrypting m0 fails as too
		// old.
		const lateReceiver = initReceiverSenderKey(senderKeyDistribution(sender));
		expect(() => senderKeyDecrypt(lateReceiver, m0, GROUP)).toThrow(/too old/i);
	});

	it('a retained receiver key CANNOT decrypt messages after the sender rotates (removal secrecy)', () => {
		// The removal threat model: a removed member kept the sender key of
		// every remaining member. Removing them from fan-out is NOT enough —
		// they can obtain ciphertexts out-of-band and the hash ratchet lets
		// them derive future keys from the retained chain key. The security
		// boundary is ROTATION: each remaining member generates a fresh sender
		// key, so the removed member's retained state is dead.
		const beforeRotation = generateSenderKey();
		const retainedByRemovedMember = initReceiverSenderKey(senderKeyDistribution(beforeRotation));

		// Sanity: the retained state works BEFORE rotation.
		const oldMsg = senderKeyEncrypt(beforeRotation, utf8('pre-rotation'), GROUP);
		expect(str(senderKeyDecrypt(retainedByRemovedMember, oldMsg, GROUP))).toBe('pre-rotation');

		// The member rotates (fresh key). Legitimate remaining members get the
		// new distribution; the removed member does not.
		const afterRotation = generateSenderKey();
		const postMsg = senderKeyEncrypt(afterRotation, utf8('post-rotation secret'), GROUP);

		// The removed member's RETAINED receiver state cannot decrypt the
		// post-rotation message — it's signed by a new key and derives from a
		// new chain the removed member never saw.
		expect(() => senderKeyDecrypt(retainedByRemovedMember, postMsg, GROUP)).toThrow();
	});

	it('refuses to skip an implausibly large number of iterations (DoS guard)', () => {
		const sender = generateSenderKey();
		const receiver = initReceiverSenderKey(senderKeyDistribution(sender)); // at iteration 0

		// A legitimately-signed message far ahead of the receiver's chain.
		let far: SenderKeyMessage | null = null;
		for (let i = 0; i < 60; i++) {
			const m = senderKeyEncrypt(sender, utf8(`m${i}`), GROUP);
			if (i === 55) far = m;
		}
		// Receiver still at iteration 0, maxSkip 50 → 55 skips is refused
		// (before the signature is even relevant — the point is the bound).
		expect(() => senderKeyDecrypt(receiver, far as SenderKeyMessage, GROUP, 50)).toThrow(/implausibly large/i);
	});
});
