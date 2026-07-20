// End-to-end proof that option C works through the REAL receive path.
//
// The unit tests cover the pieces (sessionSet's tie-break, sessionRecord's
// shape, the keystore's multi-session storage). This drives two real users
// through encryptForSend / decryptIncoming against a real keystore, because the
// failure modes here are integration-only: a save that clobbers a retained
// session, or a message that decrypts on a retained session but gets written
// back as the current one.
//
// Both "users" live in the same in-memory keystore, keyed by username — every
// keystore call already takes the username, so one process can play both sides.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreKeyBundleResponse, WsMessageFrame, WsSendFrame } from '../shared/types';

const fetchBundleAnonymous = vi.fn();

vi.mock('../src/lib/sealedFetch', () => ({
	apiFetchBundleAnonymous: (contact: string) => fetchBundleAnonymous(contact),
	apiSealedSend: vi.fn(),
}));
vi.mock('../src/lib/api', () => ({
	apiFetchBundle: vi.fn().mockResolvedValue({ status: 'not-found' }),
	apiRegisterSealToken: vi.fn(),
}));

const keystore = await import('../src/keystore');
const { decryptIncoming, encryptForSend, ensureSession } = await import('../src/lib/messaging');
const { bytesToBase64 } = await import('../src/keystore/codec');

/** The bundle the server would publish for `user`, read from their keystore. */
async function publishedBundle(user: string): Promise<PreKeyBundleResponse> {
	const identity = await keystore.getIdentity(user);
	const spk = await keystore.getSignedPreKey(user);
	return {
		identityPubkey: {
			signingPublicKey: bytesToBase64(identity.signing.publicKey),
			dhPublicKey: bytesToBase64(identity.dh.publicKey),
		},
		signedPrekey: { publicKey: bytesToBase64(spk.keyPair.publicKey), signature: bytesToBase64(spk.signature) },
		oneTimePreKey: null,
		sealToken: null,
	} as PreKeyBundleResponse;
}

/** Route the (mocked) anonymous bundle lookup to whichever user is asked for. */
function serveBundles(users: string[]) {
	fetchBundleAnonymous.mockImplementation(async (contact: string) =>
		users.includes(contact) ? { status: 'ok', bundle: await publishedBundle(contact) } : { status: 'not-found' }
	);
}

/** The envelope the server hands the recipient, built from a send frame. */
function envelope(from: string, frame: WsSendFrame): WsMessageFrame {
	return {
		type: 'message',
		id: frame.id,
		from,
		ciphertext: frame.ciphertext,
		header: frame.header,
		x3dh: frame.x3dh,
		ts: 0,
	} as WsMessageFrame;
}

async function send(from: string, to: string, text: string): Promise<WsMessageFrame> {
	await ensureSession(from, to);
	const frame = await encryptForSend(from, to, crypto.randomUUID(), { t: 'text', text }, null, 'tok', crypto.randomUUID());
	return envelope(from, frame);
}

/** A first send that still carries its X3DH material (the glare case). */
async function firstSend(from: string, to: string, text: string): Promise<WsMessageFrame> {
	const established = await ensureSession(from, to);
	const handshake = established.status === 'ok' ? established.pendingHandshake : null;
	const frame = await encryptForSend(from, to, crypto.randomUUID(), { t: 'text', text }, handshake, 'tok', crypto.randomUUID());
	return envelope(from, frame);
}

let alice: string;
let bob: string;

beforeEach(async () => {
	vi.clearAllMocks();
	const stamp = Math.floor(performance.now() * 1000);
	// Names chosen so the tie-break winner is unambiguous: a_* sorts below b_*.
	alice = `a_alice_${stamp}`;
	bob = `b_bob_${stamp}`;
	await keystore.createIdentity(alice, 'correcthorsebattery');
	await keystore.createIdentity(bob, 'correcthorsebattery');
	serveBundles([alice, bob]);
});

describe('ordinary first contact still works', () => {
	it('delivers a first message and a reply', async () => {
		const hello = await firstSend(alice, bob, 'hello bob');
		const received = await decryptIncoming(bob, hello);
		expect(received.status).toBe('ok');
		expect(received.status === 'ok' && received.displayMessage.text).toBe('hello bob');

		const reply = await send(bob, alice, 'hi alice');
		const back = await decryptIncoming(alice, reply);
		expect(back.status === 'ok' && back.displayMessage.text).toBe('hi alice');

		// One session each — the common case must not grow the set.
		expect((await keystore.loadSessionSet(alice, bob))?.sessions).toHaveLength(1);
		expect((await keystore.loadSessionSet(bob, alice))?.sessions).toHaveLength(1);
	});
});

describe('glare through the real receive path', () => {
	/** Both sides send before either receives, then each reads the other. */
	async function collide() {
		const fromAlice = await firstSend(alice, bob, 'from alice');
		const fromBob = await firstSend(bob, alice, 'from bob');

		const bobGot = await decryptIncoming(bob, fromAlice);
		const aliceGot = await decryptIncoming(alice, fromBob);
		return { aliceGot, bobGot };
	}

	it('loses neither message', async () => {
		const { aliceGot, bobGot } = await collide();

		expect(bobGot.status === 'ok' && bobGot.displayMessage.text).toBe('from alice');
		expect(aliceGot.status === 'ok' && aliceGot.displayMessage.text).toBe('from bob');
	});

	it('retains both sessions rather than clobbering one', async () => {
		await collide();

		expect((await keystore.loadSessionSet(alice, bob))?.sessions).toHaveLength(2);
		expect((await keystore.loadSessionSet(bob, alice))?.sessions).toHaveLength(2);
	});

	it('converges: the loser yields, the winner keeps its own session', async () => {
		await collide();

		// alice < bob, so Alice is the designated initiator and keeps sending on
		// the session she created; Bob moves to the one he read her on.
		expect((await keystore.loadSessionSet(alice, bob))?.current).toBe(0);
		expect((await keystore.loadSessionSet(bob, alice))?.current).toBe(1);
	});

	it('keeps talking both ways after the collision, for many messages', async () => {
		// The assertion that actually discriminates. Delivery alone would pass even
		// with a broken tie-break, because both sides hold both sessions. Sustained
		// bidirectional traffic only keeps working if they converged — and it also
		// catches a save that writes an advanced session back to the wrong index.
		await collide();

		for (let i = 0; i < 5; i++) {
			const a = await send(alice, bob, `alice ${i}`);
			const gotA = await decryptIncoming(bob, a);
			expect(gotA.status === 'ok' && gotA.displayMessage.text).toBe(`alice ${i}`);

			const b = await send(bob, alice, `bob ${i}`);
			const gotB = await decryptIncoming(alice, b);
			expect(gotB.status === 'ok' && gotB.displayMessage.text).toBe(`bob ${i}`);
		}
	});

	it('reads a straggler on the superseded session AFTER both sides have sent', async () => {
		// The scenario the retained session actually exists for, and the one that
		// discriminates: Bob queued a message on his own session before he learned
		// about Alice's, and it lands only after normal traffic has resumed. Alice
		// can read it solely because she kept the session she adopted — so a
		// `saveSession` that rewrites the whole record on every send breaks this,
		// while ordinary back-and-forth would keep working and hide the damage.
		await collide();

		// Normal converged traffic — each send persists an advanced ratchet.
		await decryptIncoming(bob, await send(alice, bob, 'after 1'));
		await decryptIncoming(alice, await send(bob, alice, 'after 2'));

		// Alice's sending session, so we can prove reading a straggler leaves it alone.
		const aliceBefore = await keystore.loadSessionSet(alice, bob);
		const aliceCurrentBefore = aliceBefore!.sessions[aliceBefore!.current].associatedData;

		// Bob's straggler, encrypted on the session he has since stopped using.
		const bobSet = await keystore.loadSessionSet(bob, alice);
		const superseded = bobSet!.sessions.find((_, i) => i !== bobSet!.current)!;
		const { ratchetEncrypt } = await import('../src/crypto/doubleRatchet');
		const { wrapSealed } = await import('../src/lib/sealedWrap');
		const { encodeChatPayload } = await import('../src/lib/chatPayload');
		const sent = ratchetEncrypt(
			superseded.ratchet,
			wrapSealed(bob, 'tok', crypto.randomUUID(), encodeChatPayload({ t: 'text', text: 'queued earlier' })),
			superseded.associatedData
		);

		const straggler = await decryptIncoming(alice, {
			type: 'message',
			id: crypto.randomUUID(),
			from: bob,
			ciphertext: bytesToBase64(sent.ciphertext),
			header: { encryptedHeader: bytesToBase64(sent.encryptedHeader) },
			ts: 0,
		} as WsMessageFrame);

		expect(straggler.status === 'ok' && straggler.displayMessage.text).toBe('queued earlier');

		// Reading it must write the advance back to the session that ACTUALLY
		// advanced, not to the current one. Asserted on state because behavior
		// hides it: writing to the wrong index overwrites the session we send on
		// with a copy of the retained one, and trial-decrypt on the peer's side
		// still finds a match, so messages keep flowing over quietly corrupt
		// state. The identity of the current session is the observable.
		const aliceAfter = await keystore.loadSessionSet(alice, bob);
		expect(aliceAfter!.current).toBe(0);
		expect(aliceAfter!.sessions[0].associatedData).toEqual(aliceCurrentBefore);

		// ...and the converged session is undisturbed by having read it.
		const after = await decryptIncoming(bob, await send(alice, bob, 'still fine'));
		expect(after.status === 'ok' && after.displayMessage.text).toBe('still fine');
	});

	it('still reads a straggler that arrives on the retained session', async () => {
		// Bob queued a second message on his own (now superseded) session before
		// he learned about Alice's. Alice must still be able to read it off the
		// session she retained — and doing so must not corrupt the one she sends on.
		const fromAlice = await firstSend(alice, bob, 'from alice');
		const bobFirst = await firstSend(bob, alice, 'from bob 1');
		const bobSecond = await send(bob, alice, 'from bob 2'); // same old session

		await decryptIncoming(bob, fromAlice);
		expect((await decryptIncoming(alice, bobFirst)).status).toBe('ok');

		const straggler = await decryptIncoming(alice, bobSecond);
		expect(straggler.status === 'ok' && straggler.displayMessage.text).toBe('from bob 2');

		// And the converged session still works afterwards.
		const after = await send(alice, bob, 'still fine');
		const got = await decryptIncoming(bob, after);
		expect(got.status === 'ok' && got.displayMessage.text).toBe('still fine');
	});
});
