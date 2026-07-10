import { describe, expect, it } from 'vitest';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import type { WsDeliveredFrame, WsMessageFrame } from '../shared/types';

const BASE = 'https://example.com';

async function signupAndConnect(username: string): Promise<WebSocket> {
	const signupRes = await SELF.fetch(`${BASE}/api/auth/signup`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password: 'correcthorsebattery' }),
	});
	const cookie = signupRes.headers.get('Set-Cookie')?.split(';')[0];
	if (!cookie) throw new Error('Expected a Set-Cookie header from signup');

	const wsRes = await SELF.fetch(`${BASE}/ws`, { headers: { Upgrade: 'websocket', Cookie: cookie } });
	expect(wsRes.status).toBe(101);
	const ws = wsRes.webSocket;
	if (!ws) throw new Error('Expected a websocket on the 101 response');
	ws.accept();
	return ws;
}

function nextMessage(ws: WebSocket): Promise<WsMessageFrame> {
	return new Promise((resolve) => {
		ws.addEventListener('message', (event) => resolve(JSON.parse(event.data as string) as WsMessageFrame), { once: true });
	});
}

// Collects the next `count` frames a socket receives, in the order the
// socket actually emits them (not necessarily the order `send` was called
// server-side — that's exactly what these ordering tests are checking).
function collectMessages(ws: WebSocket, count: number): Promise<WsMessageFrame[]> {
	return new Promise((resolve) => {
		const received: WsMessageFrame[] = [];
		const handler = (event: MessageEvent) => {
			received.push(JSON.parse(event.data as string) as WsMessageFrame);
			if (received.length >= count) {
				ws.removeEventListener('message', handler);
				resolve(received);
			}
		};
		ws.addEventListener('message', handler);
	});
}

function nextFrameOfType<T>(ws: WebSocket, type: string): Promise<T> {
	return new Promise((resolve) => {
		const handler = (event: MessageEvent) => {
			const frame = JSON.parse(event.data as string) as { type: string };
			if (frame.type === type) {
				ws.removeEventListener('message', handler);
				resolve(frame as T);
			}
		};
		ws.addEventListener('message', handler);
	});
}

const FAKE_HEADER = { dhPublicKey: 'fake-dh-pubkey', previousChainLength: 0, messageNumber: 0 };

describe('mailbox durable object — real routing (M3)', () => {
	it('rejects a direct DO connection with no X-Authenticated-User header', async () => {
		const stub = env.MAILBOX.getByName('direct-do-test-user');
		const response = await stub.fetch(`${BASE}/ws`, { headers: { Upgrade: 'websocket' } });
		expect(response.status).toBe(401);
	});

	it('rejects an upgrade request with no Upgrade header', async () => {
		const stub = env.MAILBOX.getByName('echo-test-user-2');
		const response = await stub.fetch(`${BASE}/ws`);
		expect(response.status).toBe(426);
	});

	it('rejects an unauthenticated /ws upgrade through the worker route', async () => {
		const res = await SELF.fetch(`${BASE}/ws`, { headers: { Upgrade: 'websocket' } });
		expect(res.status).toBe(401);
	});

	it('delivers a message live from one connected user to another', async () => {
		const alice = await signupAndConnect('alice_mailbox');
		const bob = await signupAndConnect('bob_mailbox');

		const bobReceived = nextMessage(bob);
		alice.send(
			JSON.stringify({ type: 'send', to: 'bob_mailbox', ciphertext: 'ct-hello-bob', header: FAKE_HEADER })
		);

		const envelope = await bobReceived;
		expect(envelope.type).toBe('message');
		expect(envelope.from).toBe('alice_mailbox');
		expect(envelope.ciphertext).toBe('ct-hello-bob');
		expect(envelope.header).toEqual(FAKE_HEADER);
		expect(typeof envelope.id).toBe('string');
		expect(typeof envelope.ts).toBe('number');

		alice.close();
		bob.close();
	});

	it('queues a message for an offline recipient and flushes it on their next connect', async () => {
		const erin = await signupAndConnect('erin_mailbox');

		const franLoginRes = await SELF.fetch(`${BASE}/api/auth/signup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'fran_mailbox', password: 'correcthorsebattery' }),
		});
		const franCookie = franLoginRes.headers.get('Set-Cookie')?.split(';')[0];
		if (!franCookie) throw new Error('Expected a Set-Cookie header from signup');

		erin.send(JSON.stringify({ type: 'send', to: 'fran_mailbox', ciphertext: 'ct-queued-for-fran', header: FAKE_HEADER }));
		await new Promise((resolve) => setTimeout(resolve, 10));

		const franWsRes = await SELF.fetch(`${BASE}/ws`, { headers: { Upgrade: 'websocket', Cookie: franCookie } });
		const fran = franWsRes.webSocket;
		if (!fran) throw new Error('Expected a websocket on the 101 response');
		fran.accept();

		const envelope = await nextMessage(fran);
		expect(envelope.from).toBe('erin_mailbox');
		expect(envelope.ciphertext).toBe('ct-queued-for-fran');

		erin.close();
		fran.close();
	});

	it('flushes multiple queued messages for an offline recipient in send order', async () => {
		// Regression test: ctx.storage.list() sorts by key, not insertion
		// order. Keying stored envelopes purely by a random id would flush
		// them in effectively random order — this test sends distinguishable
		// messages while the recipient is offline and asserts they arrive
		// back in the exact order they were sent.
		const gabe = await signupAndConnect('gabe_mailbox');

		const heidiRes = await SELF.fetch(`${BASE}/api/auth/signup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'heidi_mailbox', password: 'correcthorsebattery' }),
		});
		const heidiCookie = heidiRes.headers.get('Set-Cookie')?.split(';')[0];
		if (!heidiCookie) throw new Error('Expected a Set-Cookie header from signup');

		const messageCount = 8;
		for (let i = 0; i < messageCount; i++) {
			gabe.send(JSON.stringify({ type: 'send', to: 'heidi_mailbox', ciphertext: `ct-${i}`, header: FAKE_HEADER }));
			// A tiny stagger so consecutive envelopes don't collide on the same
			// millisecond timestamp, which would otherwise mask an ordering bug
			// by accident (same ms -> same sort prefix -> order not exercised).
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		await new Promise((resolve) => setTimeout(resolve, 20));

		const heidiWsRes = await SELF.fetch(`${BASE}/ws`, { headers: { Upgrade: 'websocket', Cookie: heidiCookie } });
		const heidi = heidiWsRes.webSocket;
		if (!heidi) throw new Error('Expected a websocket on the 101 response');
		heidi.accept();

		const envelopes = await collectMessages(heidi, messageCount);
		expect(envelopes.map((e) => e.ciphertext)).toEqual(Array.from({ length: messageCount }, (_, i) => `ct-${i}`));

		gabe.close();
		heidi.close();
	});

	it('deletes a queued envelope only once the recipient acks it', async () => {
		const ivan = await signupAndConnect('ivan_mailbox');
		const judyRes = await SELF.fetch(`${BASE}/api/auth/signup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'judy_mailbox', password: 'correcthorsebattery' }),
		});
		const judyCookie = judyRes.headers.get('Set-Cookie')?.split(';')[0];
		if (!judyCookie) throw new Error('Expected a Set-Cookie header from signup');

		ivan.send(JSON.stringify({ type: 'send', id: 'msg-ack-1', to: 'judy_mailbox', ciphertext: 'ct-ack', header: FAKE_HEADER }));
		await new Promise((resolve) => setTimeout(resolve, 10));

		const judyStub = env.MAILBOX.getByName('judy_mailbox');
		const queuedBeforeAck = await runInDurableObject(judyStub, async (_i, state) => {
			const list = await state.storage.list({ prefix: 'envelope:' });
			return [...list.keys()];
		});
		expect(queuedBeforeAck.length).toBe(1);

		// Judy connects, receives the envelope, and acks it.
		const judyWsRes = await SELF.fetch(`${BASE}/ws`, { headers: { Upgrade: 'websocket', Cookie: judyCookie } });
		const judy = judyWsRes.webSocket;
		if (!judy) throw new Error('Expected a websocket on the 101 response');
		judy.accept();
		const envelope = await nextMessage(judy);
		judy.send(JSON.stringify({ type: 'ack', messageId: envelope.id, to: 'ivan_mailbox' }));
		await new Promise((resolve) => setTimeout(resolve, 10));

		const queuedAfterAck = await runInDurableObject(judyStub, async (_i, state) => {
			const list = await state.storage.list({ prefix: 'envelope:' });
			return [...list.keys()];
		});
		expect(queuedAfterAck.length).toBe(0);

		ivan.close();
		judy.close();
	});

	it('notifies the original sender that a message was delivered', async () => {
		const kara = await signupAndConnect('kara_mailbox');
		const liam = await signupAndConnect('liam_mailbox');

		// Both online → live delivery. Kara sends, Liam acks, Kara should get a
		// 'delivered' frame referencing the same message id.
		const deliveredPromise = nextFrameOfType<WsDeliveredFrame>(kara, 'delivered');
		const liamMessage = nextMessage(liam);
		kara.send(JSON.stringify({ type: 'send', id: 'msg-deliver-1', to: 'liam_mailbox', ciphertext: 'ct-live', header: FAKE_HEADER }));

		const envelope = await liamMessage;
		liam.send(JSON.stringify({ type: 'ack', messageId: envelope.id, to: 'kara_mailbox' }));

		const delivered = await deliveredPromise;
		expect(delivered.messageId).toBe('msg-deliver-1');
		expect(delivered.from).toBe('liam_mailbox');

		kara.close();
		liam.close();
	});

	it('TTL sweep deletes envelopes older than 14 days but keeps fresh ones', async () => {
		const stub = env.MAILBOX.getByName('ttl_mailbox_user');
		const now = Date.now();
		const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;

		await runInDurableObject(stub, async (_i, state) => {
			await state.storage.put('envelope:sender:000000000001:old', {
				type: 'message', id: 'old', from: 'sender', ciphertext: 'x', header: FAKE_HEADER, ts: now - fourteenDaysMs - 60_000, seq: 1,
			});
			await state.storage.put('envelope:sender:000000000002:fresh', {
				type: 'message', id: 'fresh', from: 'sender', ciphertext: 'x', header: FAKE_HEADER, ts: now, seq: 2,
			});
		});

		// Invoke the sweep handler directly — tests the 14-day cutoff logic
		// itself, independent of the alarm-scheduling wiring (which is a plain
		// setAlarm and exercised via runDurableObjectAlarm elsewhere).
		await runInDurableObject(stub, async (instance) => {
			await (instance as unknown as { alarm(): Promise<void> }).alarm();
		});

		const remaining = await runInDurableObject(stub, async (_i, state) => {
			const list = await state.storage.list({ prefix: 'envelope:' });
			return [...list.keys()];
		});
		expect(remaining.some((k) => k.includes(':old'))).toBe(false);
		expect(remaining.some((k) => k.includes(':fresh'))).toBe(true);
	});
});

describe('mailbox flooding / size caps (H2)', () => {
	const MAX_QUEUED = 500; // must match worker/mailbox.ts MAX_QUEUED_ENVELOPES
	const env0 = (id: string, ciphertext = 'x') => ({
		type: 'message' as const, id, from: 'flooder', ciphertext, header: FAKE_HEADER, ts: Date.now(), seq: 1,
	});
	const deliver = (username: string, envelope: unknown) =>
		env.MAILBOX.getByName(username).fetch('https://internal/deliver', {
			method: 'POST',
			body: JSON.stringify({ recipient: username, envelope }),
		});
	const count = (stub: DurableObjectStub) =>
		runInDurableObject(stub, async (_i, state) => (await state.storage.list({ prefix: 'envelope:' })).size);

	it('drops the incoming envelope once the queue is at the cap (no unbounded growth, still 204)', async () => {
		const stub = env.MAILBOX.getByName('flood_victim');
		// Seed the queue exactly to the cap.
		await runInDurableObject(stub, async (_i, state) => {
			for (let i = 0; i < MAX_QUEUED; i++) {
				await state.storage.put(`envelope:seed:${String(i).padStart(12, '0')}:s${i}`, env0(`s${i}`));
			}
		});
		expect(await count(stub)).toBe(MAX_QUEUED);
		const res = await deliver('flood_victim', env0('overflow'));
		expect(res.status).toBe(204); // success-shaped, not an oracle
		expect(await count(stub)).toBe(MAX_QUEUED); // did NOT grow to 501
	});

	it('drops an oversized envelope without storing it (still 204)', async () => {
		const stub = env.MAILBOX.getByName('big_victim');
		const huge = env0('huge', 'x'.repeat(70 * 1024)); // > 64 KiB
		const res = await deliver('big_victim', huge);
		expect(res.status).toBe(204);
		expect(await count(stub)).toBe(0);
	});

	it('a normal-size envelope to an offline recipient is queued as before', async () => {
		const stub = env.MAILBOX.getByName('normal_victim');
		const res = await deliver('normal_victim', env0('normal'));
		expect(res.status).toBe(204);
		expect(await count(stub)).toBe(1);
	});
});
