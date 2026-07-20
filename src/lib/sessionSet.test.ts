// Option C: a contact can hold more than one ratchet session, and a glare
// converges onto exactly one of them.
//
// Holding several sessions is what removes the message loss: in a glare each
// side can read the other's messages on a responder session while still sending
// on its own. The tie-break is NOT what makes delivery work — two parallel
// one-directional chains already deliver both ways. It's what makes both sides
// CONVERGE onto a single bidirectional session, which matters because a chain
// nobody ever replies on never takes a DH ratchet step, so its forward secrecy
// degrades.
//
// That distinction drives these tests: a "messages arrive" assertion passes even
// with a broken tie-break. The discriminating assertion is that after the
// exchange both sides can drop every session except the one they send on and
// keep talking.
import { describe, expect, it } from 'vitest';
import { generateIdentityKeyPair, generateSignedPreKey, initiateX3DH, respondX3DH } from '../crypto/x3dh';
import { initRatchetAsInitiator, initRatchetAsResponder, ratchetEncrypt } from '../crypto/doubleRatchet';
import type { SignedPreKey } from '../crypto/types';
import { isDesignatedInitiator, trialDecryptSessions, type SessionEntry } from './sessionSet';

type Identity = ReturnType<typeof generateIdentityKeyPair>;
const utf8 = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);

function initiatorSession(me: Identity, peer: Identity, peerSpk: SignedPreKey) {
	const hs = initiateX3DH({
		initiatorIdentity: me,
		responderIdentity: { signingPublicKey: peer.signing.publicKey, dhPublicKey: peer.dh.publicKey },
		responderSignedPreKey: { publicKey: peerSpk.keyPair.publicKey, signature: peerSpk.signature },
	});
	return {
		entry: { ratchet: initRatchetAsInitiator(hs.sharedSecret, peerSpk.keyPair.publicKey), associatedData: hs.associatedData },
		wire: { initiatorIdentityDhPublicKey: me.dh.publicKey, initiatorEphemeralPublicKey: hs.ephemeralPublicKey },
	};
}

function responderSession(me: Identity, mySpk: SignedPreKey, wire: { initiatorIdentityDhPublicKey: Uint8Array; initiatorEphemeralPublicKey: Uint8Array }): SessionEntry {
	const hs = respondX3DH({
		responderIdentity: me,
		responderSignedPreKey: mySpk,
		initiatorIdentityDhPublicKey: wire.initiatorIdentityDhPublicKey,
		initiatorEphemeralPublicKey: wire.initiatorEphemeralPublicKey,
	});
	return { ratchet: initRatchetAsResponder(hs.sharedSecret, mySpk.keyPair), associatedData: hs.associatedData };
}

describe('the tie-break', () => {
	it('picks the lexicographically lower username as the designated initiator', () => {
		expect(isDesignatedInitiator('alice', 'bob')).toBe(true);
		expect(isDesignatedInitiator('bob', 'alice')).toBe(false);
	});

	it('is symmetric — both sides always agree on exactly one winner', () => {
		const names = ['alice', 'Bob', 'carol_9', 'Z_user', 'aa', 'a_b', '007bond'];
		for (const a of names) {
			for (const b of names) {
				if (a === b) continue;
				expect(isDesignatedInitiator(a, b)).toBe(!isDesignatedInitiator(b, a));
			}
		}
	});

	it('compares raw code units, so ASCII case ranks before lowercase', () => {
		// The usernames charset is [a-zA-Z0-9_], and lookups are exact-match, so
		// both sides always hold the identical byte string. Plain code-unit
		// ordering — never localeCompare, which would disagree across locales.
		expect(isDesignatedInitiator('Zeta', 'alpha')).toBe(true); // 'Z'(90) < 'a'(97)
		expect('Zeta'.localeCompare('alpha') < 0).toBe(false); // the trap being avoided
	});
});

describe('trial decryption across a contact\'s sessions', () => {
	it('finds the one session that can read the message', () => {
		const alice = generateIdentityKeyPair();
		const bob = generateIdentityKeyPair();
		const bobSpk = generateSignedPreKey(bob);
		const a = initiatorSession(alice, bob, bobSpk);
		const bobReal = responderSession(bob, bobSpk, a.wire);

		// A decoy session with an unrelated third party — cannot read A's message.
		const carol = generateIdentityKeyPair();
		const decoy = initiatorSession(bob, carol, generateSignedPreKey(carol)).entry;

		const sent = ratchetEncrypt(a.entry.ratchet, utf8('hello'), a.entry.associatedData);
		const found = trialDecryptSessions([decoy, bobReal], sent.encryptedHeader, sent.ciphertext);

		expect(found?.index).toBe(1);
		expect(str(found!.plaintext)).toBe('hello');
	});

	it('returns null when no session matches', () => {
		const alice = generateIdentityKeyPair();
		const bob = generateIdentityKeyPair();
		const a = initiatorSession(alice, bob, generateSignedPreKey(bob));
		const unrelated = initiatorSession(bob, alice, generateSignedPreKey(alice)).entry;

		const sent = ratchetEncrypt(a.entry.ratchet, utf8('hello'), a.entry.associatedData);
		expect(trialDecryptSessions([unrelated], sent.encryptedHeader, sent.ciphertext)).toBeNull();
	});

	it('propagates a tampered-ciphertext failure instead of trying the next session', () => {
		// A header match means "this IS the session"; an AEAD failure after that is
		// corruption or tampering and must fail closed. Swallowing it and falling
		// through would silently retry a tampered message against every session.
		const alice = generateIdentityKeyPair();
		const bob = generateIdentityKeyPair();
		const bobSpk = generateSignedPreKey(bob);
		const a = initiatorSession(alice, bob, bobSpk);
		const bobReal = responderSession(bob, bobSpk, a.wire);
		const carol = generateIdentityKeyPair();
		const decoy = initiatorSession(bob, carol, generateSignedPreKey(carol)).entry;

		const sent = ratchetEncrypt(a.entry.ratchet, utf8('hello'), a.entry.associatedData);
		sent.ciphertext[0] ^= 0xff; // tamper

		expect(() => trialDecryptSessions([bobReal, decoy], sent.encryptedHeader, sent.ciphertext)).toThrow();
	});

	it('leaves non-matching sessions unmutated', () => {
		const alice = generateIdentityKeyPair();
		const bob = generateIdentityKeyPair();
		const bobSpk = generateSignedPreKey(bob);
		const a = initiatorSession(alice, bob, bobSpk);
		const bobReal = responderSession(bob, bobSpk, a.wire);
		const carol = generateIdentityKeyPair();
		const decoy = initiatorSession(bob, carol, generateSignedPreKey(carol)).entry;
		const decoyBefore = JSON.stringify(Array.from(decoy.ratchet.rootKey));

		const sent = ratchetEncrypt(a.entry.ratchet, utf8('hello'), a.entry.associatedData);
		trialDecryptSessions([decoy, bobReal], sent.encryptedHeader, sent.ciphertext);

		expect(JSON.stringify(Array.from(decoy.ratchet.rootKey))).toBe(decoyBefore);
	});
});

describe('glare converges onto a single session', () => {
	// Full simulation of the worst case: both sides send before either receives,
	// so both hold a competing initiator session.
	function glare() {
		const alice = generateIdentityKeyPair();
		const bob = generateIdentityKeyPair();
		const aliceSpk = generateSignedPreKey(alice);
		const bobSpk = generateSignedPreKey(bob);

		// 'alice' < 'bob', so Alice is the designated initiator and Bob yields.
		const a = initiatorSession(alice, bob, bobSpk);
		const b = initiatorSession(bob, alice, aliceSpk);

		const fromAlice = ratchetEncrypt(a.entry.ratchet, utf8('from alice'), a.entry.associatedData);
		const fromBob = ratchetEncrypt(b.entry.ratchet, utf8('from bob'), b.entry.associatedData);

		// Each side holds its own session and adopts a responder session to read
		// the other's message — no message is lost.
		const aliceSessions: SessionEntry[] = [a.entry, responderSession(alice, aliceSpk, b.wire)];
		const bobSessions: SessionEntry[] = [b.entry, responderSession(bob, bobSpk, a.wire)];

		const aliceRead = trialDecryptSessions(aliceSessions, fromBob.encryptedHeader, fromBob.ciphertext);
		const bobRead = trialDecryptSessions(bobSessions, fromAlice.encryptedHeader, fromAlice.ciphertext);

		// The winner keeps sending on its own initiator session; the loser adopts
		// the session it just read the winner's message on.
		const aliceCurrent = isDesignatedInitiator('alice', 'bob') ? 0 : aliceRead!.index;
		const bobCurrent = isDesignatedInitiator('bob', 'alice') ? 0 : bobRead!.index;

		return { aliceSessions, bobSessions, aliceCurrent, bobCurrent, aliceRead, bobRead };
	}

	it('loses no message — each side reads the other despite the collision', () => {
		const { aliceRead, bobRead } = glare();
		expect(str(aliceRead!.plaintext)).toBe('from bob');
		expect(str(bobRead!.plaintext)).toBe('from alice');
	});

	it('converges: dropping every session but the current one still talks both ways', () => {
		// THE discriminating assertion. Delivery alone passes even with a broken
		// tie-break, because both sides hold both sessions. Retiring everything
		// except the session each side sends on only keeps working if they
		// converged onto the same one.
		const { aliceSessions, bobSessions, aliceCurrent, bobCurrent } = glare();

		const aliceOnly = [aliceSessions[aliceCurrent]];
		const bobOnly = [bobSessions[bobCurrent]];

		for (let i = 0; i < 4; i++) {
			const aSent = ratchetEncrypt(aliceOnly[0].ratchet, utf8(`a${i}`), aliceOnly[0].associatedData);
			const bGot = trialDecryptSessions(bobOnly, aSent.encryptedHeader, aSent.ciphertext);
			expect(str(bGot!.plaintext)).toBe(`a${i}`);

			const bSent = ratchetEncrypt(bobOnly[0].ratchet, utf8(`b${i}`), bobOnly[0].associatedData);
			const aGot = trialDecryptSessions(aliceOnly, bSent.encryptedHeader, bSent.ciphertext);
			expect(str(aGot!.plaintext)).toBe(`b${i}`);
		}
	});

	it('converges on the winner\'s session specifically, not just any shared one', () => {
		// Pins WHICH session wins, so a tie-break that inverts is caught.
		const { aliceCurrent, bobCurrent, bobRead } = glare();
		expect(aliceCurrent).toBe(0); // Alice (lower) keeps her own initiator session
		expect(bobCurrent).toBe(bobRead!.index); // Bob yields to the one he read Alice on
		expect(bobCurrent).not.toBe(0);
	});
});
