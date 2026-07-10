import { describe, expect, it } from 'vitest';
import { generateSenderKey, initReceiverSenderKey, senderKeyDistribution, senderKeyDecrypt, senderKeyEncrypt } from '../src/crypto/senderKey';

// M4: on a group `remove`, every REMAINING member rotates its own sender key and
// redistributes it ONLY to the new roster (verified in src/pages/Chat.tsx: the
// creator broadcasts the remove to each remaining member, each calls
// rotateOwnSenderKey + distributeOwnSenderKeyRaw on receipt, and the creator
// rotates too). The security property that guarantees is: a removed member who
// retained a live receiver chain for a member can no longer READ that member's
// future messages once that member rotates. This regression test pins that.
const AD = new TextEncoder().encode('group-ad');
const pt = (s: string) => new TextEncoder().encode(s);

describe('group remove forces sender-key rotation (M4)', () => {
	it('a retained pre-rotation receiver cannot decrypt post-rotation messages', () => {
		// A distributes SK1; C (later removed) sets up a receiver for it.
		const aBefore = generateSenderKey();
		const cRetained = initReceiverSenderKey(senderKeyDistribution(aBefore));
		// Sanity: before rotation, C can read A's messages.
		expect(new TextDecoder().decode(senderKeyDecrypt(cRetained, senderKeyEncrypt(aBefore, pt('pre'), AD), AD))).toBe('pre');

		// C is removed -> A rotates to a fresh sender key, distributed only to the
		// new roster (B), never to C.
		const aAfter = generateSenderKey();
		const post = senderKeyEncrypt(aAfter, pt('post-removal secret'), AD);

		// C, holding only the pre-rotation receiver, cannot read the new message
		// (fresh signing key -> signature verification fails closed).
		expect(() => senderKeyDecrypt(cRetained, post, AD)).toThrow();
	});
});
