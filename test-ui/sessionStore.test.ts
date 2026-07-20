// Option C storage: a contact's sessions are a SET, not a single record.
//
// The risk these cover is integration-only: every existing caller does
// load-one/save-one, and the send path saves its advanced ratchet after every
// message. If saving the current session rewrites the whole record, it wipes the
// sessions retained to read a glare peer — and every unit test still passes
// while real conversations break. So these exercise the real keystore over a
// real (in-memory) IndexedDB, across save/load round trips.
import { beforeEach, describe, expect, it } from 'vitest';
import { generateIdentityKeyPair, generateSignedPreKey, initiateX3DH } from '../src/crypto/x3dh';
import { initRatchetAsInitiator } from '../src/crypto/doubleRatchet';
import * as keystore from '../src/keystore';

const utf8 = (s: string) => new TextEncoder().encode(s);

/** A throwaway but structurally real ratchet session. */
function someSession() {
	const me = generateIdentityKeyPair();
	const peer = generateIdentityKeyPair();
	const spk = generateSignedPreKey(peer);
	const hs = initiateX3DH({
		initiatorIdentity: me,
		responderIdentity: { signingPublicKey: peer.signing.publicKey, dhPublicKey: peer.dh.publicKey },
		responderSignedPreKey: { publicKey: spk.keyPair.publicKey, signature: spk.signature },
	});
	return { ratchet: initRatchetAsInitiator(hs.sharedSecret, spk.keyPair.publicKey), associatedData: hs.associatedData };
}

let me: string;

beforeEach(async () => {
	me = `alice_${Math.floor(performance.now() * 1000)}`;
	await keystore.createIdentity(me, 'correcthorsebattery');
});

describe('a contact can hold more than one session', () => {
	it('round-trips several sessions and remembers which is current', async () => {
		const first = someSession();
		const second = someSession();

		await keystore.saveSession(me, 'bob', first.ratchet, first.associatedData);
		await keystore.addSession(me, 'bob', second.ratchet, second.associatedData, true);

		const set = await keystore.loadSessionSet(me, 'bob');
		expect(set?.sessions).toHaveLength(2);
		expect(set?.current).toBe(1);
		// loadSession stays the send path's view: the current session.
		const current = await keystore.loadSession(me, 'bob');
		expect(current?.associatedData).toEqual(second.associatedData);
	});

	it('can adopt a session WITHOUT making it current (the tie-break winner)', async () => {
		const mine = someSession();
		const adopted = someSession();

		await keystore.saveSession(me, 'bob', mine.ratchet, mine.associatedData);
		await keystore.addSession(me, 'bob', adopted.ratchet, adopted.associatedData, false);

		const set = await keystore.loadSessionSet(me, 'bob');
		expect(set?.sessions).toHaveLength(2);
		expect(set?.current).toBe(0);
		expect((await keystore.loadSession(me, 'bob'))?.associatedData).toEqual(mine.associatedData);
	});

	it('SAVING THE CURRENT SESSION MUST NOT DESTROY THE RETAINED ONES', async () => {
		// The integration trap. encryptForSend saves the advanced ratchet after
		// every send; if that rewrites the record, the glare peer's session is
		// gone and their messages become undecryptable.
		const mine = someSession();
		const adopted = someSession();
		await keystore.saveSession(me, 'bob', mine.ratchet, mine.associatedData);
		await keystore.addSession(me, 'bob', adopted.ratchet, adopted.associatedData, false);

		// A send: load current, advance it, save it back.
		const current = await keystore.loadSession(me, 'bob');
		await keystore.saveSession(me, 'bob', current!.ratchet, current!.associatedData);

		const set = await keystore.loadSessionSet(me, 'bob');
		expect(set?.sessions).toHaveLength(2);
		expect(set?.current).toBe(0);
		expect(set?.sessions[1].associatedData).toEqual(adopted.associatedData);
	});

	it('persists an advanced session by index without disturbing the others', async () => {
		const a = someSession();
		const b = someSession();
		await keystore.saveSession(me, 'bob', a.ratchet, a.associatedData);
		await keystore.addSession(me, 'bob', b.ratchet, b.associatedData, false);

		const set = await keystore.loadSessionSet(me, 'bob');
		await keystore.saveSessionAt(me, 'bob', 1, set!.sessions[1].ratchet, set!.sessions[1].associatedData);

		const after = await keystore.loadSessionSet(me, 'bob');
		expect(after?.sessions).toHaveLength(2);
		expect(after?.sessions[0].associatedData).toEqual(a.associatedData);
		expect(after?.current).toBe(0);
	});

	it('caps retained sessions, evicting the oldest non-current one', async () => {
		// Unbounded sessions would mean unbounded retained key material, which
		// cuts against the forward-secrecy story.
		const first = someSession();
		await keystore.saveSession(me, 'bob', first.ratchet, first.associatedData);
		for (let i = 0; i < 5; i++) {
			const extra = someSession();
			await keystore.addSession(me, 'bob', extra.ratchet, extra.associatedData, false);
		}

		const set = await keystore.loadSessionSet(me, 'bob');
		expect(set!.sessions.length).toBeLessThanOrEqual(3);
		// The current session is never evicted.
		expect(set!.sessions[set!.current].associatedData).toEqual(first.associatedData);
	});
});

describe('removing a contact', () => {
	it('drops every session, not just the current one', async () => {
		const a = someSession();
		const b = someSession();
		await keystore.saveSession(me, 'bob', a.ratchet, a.associatedData);
		await keystore.addSession(me, 'bob', b.ratchet, b.associatedData, false);
		await keystore.addContact(me, 'bob', {
			signingPublicKey: utf8('sig-placeholder-32-bytes-padding'),
			dhPublicKey: utf8('dh--placeholder-32-bytes-padding'),
		});

		await keystore.removeContact(me, 'bob');

		expect(await keystore.loadSessionSet(me, 'bob')).toBeNull();
		expect(await keystore.hasSession(me, 'bob')).toBe(false);
	});
});
