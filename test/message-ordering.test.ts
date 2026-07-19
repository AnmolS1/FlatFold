import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { decodeChatPayload, encodeChatPayload, type ChatPayload } from '../src/lib/chatPayload';
import { displayTsFor, orderedVisibleMessages } from '../src/lib/messageOrder';
import type { DisplayMessage, WsMessageFrame } from '../shared/types';

// Messages within one minute used to render in ARRIVAL order, not send order.
// Cause: sent messages are stamped `Date.now()` (ms) while received messages
// were stamped with the envelope `ts`, which worker/mailbox.ts coarsens to the
// minute for privacy — so every received message collapsed to `:00.000` and
// sorted ahead of same-minute sent messages.
//
// The fix carries the sender's precise `sentAt` INSIDE the AEAD-encrypted
// ChatPayload. These tests pin both halves: that ordering now follows the
// sender's clock, and that the precise time never escapes the ciphertext.

const BASE = 'https://example.com';
const MINUTE = 60_000;
const at = (h: number, m: number, s: number, ms = 0) => Date.UTC(2026, 0, 1, h, m, s, ms);
const coarsen = (ts: number) => Math.floor(ts / MINUTE) * MINUTE;

function msg(over: Partial<DisplayMessage> & { id: string; ts: number }): DisplayMessage {
	return { from: 'ada', text: 'x', direction: 'received', ...over };
}

describe('same-minute ordering follows the sender clock', () => {
	it('sorts a received message after a sent one when it was sent later in the minute', () => {
		// The exact scenario from the bug report: you send at :10, they send at
		// :30. Their envelope ts is coarsened to :00, which would sort them first.
		const sent = msg({ id: 'sent', from: 'me', direction: 'sent', ts: at(10, 5, 10, 500) });
		const receivedFrameTs = coarsen(at(10, 5, 30, 200));
		expect(receivedFrameTs).toBe(at(10, 5, 0, 0)); // the server really does collapse it

		const received = msg({ id: 'received', ts: displayTsFor(at(10, 5, 30, 200), receivedFrameTs) });

		const ordered = orderedVisibleMessages([received, sent], at(10, 6, 0));
		expect(ordered.map((m) => m.id)).toEqual(['sent', 'received']);
	});

	it('reproduces the old misordering when sentAt is absent (the legacy fallback)', () => {
		// A pre-fix sender sends no `sentAt`, so we fall back to the coarsened
		// envelope ts and the old behavior persists for that message only. This
		// pins the fallback as a deliberate, bounded degradation.
		const sent = msg({ id: 'sent', from: 'me', direction: 'sent', ts: at(10, 5, 10, 500) });
		const legacy = msg({ id: 'legacy', ts: displayTsFor(undefined, coarsen(at(10, 5, 30, 200))) });

		expect(orderedVisibleMessages([sent, legacy], at(10, 6, 0)).map((m) => m.id)).toEqual(['legacy', 'sent']);
	});

	it('interleaves a back-and-forth burst within one minute in true send order', () => {
		const times = [
			['a-sent', at(10, 5, 2, 100), true],
			['b-recv', at(10, 5, 5, 900), false],
			['c-sent', at(10, 5, 11, 40), true],
			['d-recv', at(10, 5, 12, 10), false],
			['e-recv', at(10, 5, 40, 750), false],
		] as const;

		const messages = times.map(([id, ts, isSent]) =>
			isSent
				? msg({ id, from: 'me', direction: 'sent', ts })
				: // received: precise sentAt inside the payload, coarsened envelope outside
					msg({ id, ts: displayTsFor(ts, coarsen(ts)) })
		);

		// Shuffled arrival order — every received one would otherwise tie at :00.
		const arrived = [messages[4], messages[1], messages[3], messages[0], messages[2]];
		expect(orderedVisibleMessages(arrived, at(10, 6, 0)).map((m) => m.id)).toEqual([
			'a-sent',
			'b-recv',
			'c-sent',
			'd-recv',
			'e-recv',
		]);
	});

	it('still drops expired messages while ordering', () => {
		const now = at(10, 5, 30);
		const live = msg({ id: 'live', ts: at(10, 5, 10), expiresAt: now + 1000 });
		const dead = msg({ id: 'dead', ts: at(10, 5, 5), expiresAt: now - 1000 });
		expect(orderedVisibleMessages([dead, live], now).map((m) => m.id)).toEqual(['live']);
	});
});

describe('sentAt survives the encrypted round trip', () => {
	it('round-trips on a text payload', () => {
		const sentAt = at(10, 5, 30, 200);
		const payload: ChatPayload = { t: 'text', text: 'hello', sentAt };
		const decoded = decodeChatPayload(encodeChatPayload(payload));
		expect(decoded).toEqual(payload);
		expect(decoded.t === 'text' && decoded.sentAt).toBe(sentAt);
	});

	it('round-trips on a media payload alongside the other optional fields', () => {
		const sentAt = at(10, 5, 30, 200);
		const payload: ChatPayload = {
			t: 'media',
			media: { id: 'm1', key: 'k', nonce: 'n', digest: 'd', mimeType: 'image/png', size: 3, mediaKind: 'image' },
			caption: 'a fold',
			sentAt,
			expiresInSeconds: 60,
		};
		const decoded = decodeChatPayload(encodeChatPayload(payload));
		expect(decoded).toEqual(payload);
	});

	it('decodes a payload with no sentAt (older sender) without error', () => {
		const decoded = decodeChatPayload(encodeChatPayload({ t: 'text', text: 'legacy' }));
		expect(decoded).toEqual({ t: 'text', text: 'legacy' });
		expect(decoded.t === 'text' && decoded.sentAt).toBeUndefined();
	});

	it('does not change the padded size bucket for a normal message', () => {
		// The padding buckets are what hide plaintext length from the server. A
		// constant ~24-byte field must not push a short message into a new bucket.
		const withOut = encodeChatPayload({ t: 'text', text: 'hello' }).length;
		const withIn = encodeChatPayload({ t: 'text', text: 'hello', sentAt: at(10, 5, 30, 200) }).length;
		expect(withIn).toBe(withOut);
	});
});

// The privacy half of the fix, checked against the REAL server rather than a
// client helper: send a payload carrying a precise `sentAt` through the actual
// worker + mailbox DO and inspect the envelope it hands the recipient. If a
// future refactor ever hoists `sentAt` out of the ciphertext into a frame
// field, or un-coarsens the envelope `ts`, this fails.
describe('privacy: the precise send time never leaves the ciphertext', () => {
	async function signupAndConnect(username: string): Promise<WebSocket> {
		const signupRes = await SELF.fetch(`${BASE}/api/auth/signup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username, password: 'correcthorsebattery' }),
		});
		const cookie = signupRes.headers.get('Set-Cookie')?.split(';')[0];
		if (!cookie) throw new Error('Expected a Set-Cookie header from signup');
		const wsRes = await SELF.fetch(`${BASE}/ws`, { headers: { Upgrade: 'websocket', Cookie: cookie } });
		const ws = wsRes.webSocket;
		if (!ws) throw new Error('Expected a websocket on the 101 response');
		ws.accept();
		return ws;
	}

	it('keeps the server-visible envelope minute-coarsened and sentAt-free', async () => {
		const sender = await signupAndConnect('ordering_sender');
		const recipient = await signupAndConnect('ordering_recipient');

		// A precise, distinctive send time, encoded exactly as the app encodes it:
		// inside the padded ChatPayload that becomes the AEAD plaintext.
		const sentAt = at(10, 5, 30, 200);
		const plaintext = encodeChatPayload({ t: 'text', text: 'hello', sentAt });
		const ciphertext = btoa(String.fromCharCode(...plaintext));

		const received = new Promise<WsMessageFrame>((resolve) => {
			recipient.addEventListener('message', (event) => resolve(JSON.parse(event.data as string) as WsMessageFrame), {
				once: true,
			});
		});
		sender.send(
			JSON.stringify({
				type: 'send',
				id: 'ordering-msg-1',
				to: 'ordering_recipient',
				ciphertext,
				header: { encryptedHeader: 'aGRy' },
			})
		);
		const envelope = await received;

		// The server stamps a minute-coarsened ts — never the precise send time.
		expect(envelope.ts % MINUTE).toBe(0);
		expect(envelope.ts).not.toBe(sentAt);

		// `sentAt` reaches the recipient only inside the opaque ciphertext...
		expect(decodeChatPayload(Uint8Array.from(atob(envelope.ciphertext), (c) => c.charCodeAt(0)))).toEqual({
			t: 'text',
			text: 'hello',
			sentAt,
		});

		// ...and appears nowhere in the rest of the envelope.
		const serverVisible: Record<string, unknown> = { ...envelope };
		delete serverVisible.ciphertext; // the one place sentAt is allowed to live
		const wire = JSON.stringify(serverVisible);
		expect(wire).not.toContain('sentAt');
		expect(wire).not.toContain(String(sentAt));
		// No server-visible field carries sub-minute precision.
		for (const value of Object.values(serverVisible)) {
			if (typeof value === 'number' && value > MINUTE) expect(value % MINUTE).toBe(0);
		}

		sender.close();
		recipient.close();
	});
});
