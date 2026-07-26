// FULL_AUDIT_2 R1. Chat.tsx is 1,751 lines with no test, and the audit and
// STATUS agree that if anything is subtly wrong it is probably in there. The two
// parts with real state-machine complexity are the inbound-frame dispatch and
// the session-op chain that the offline flush runs through, so those are what is
// pinned here.
//
// Why this matters more than it looks: when a client reconnects, the mailbox DO
// redelivers everything it queued as a BURST of frames, arriving back to back
// with no gap. Every one of them does loadSession → mutate → saveSession, and
// saveSession rewrites the whole record. Two overlapping frames clobber each
// other's ratchet state — benign inside one chain, but permanently wedging
// across a DH-ratchet step, i.e. a conversation that can never decrypt again.
// The serialization is the thing standing between an offline flush and that.
//
// The full extraction of useMailboxSocket / useConversationState (D2) is NOT
// done here; see the note in the commit. This lifts out only the two pieces the
// dispatch is built from, which is the least that makes them testable at all.
import { describe, expect, it, vi } from 'vitest';
import { createSessionOpChain, routeInboundFrame } from '../src/lib/inboundDispatch';
import type { WsDeliveredFrame, WsGroupMessageFrame, WsMessageFrame } from '../src/types';

const messageFrame = (id: string): WsMessageFrame => ({
	type: 'message',
	id,
	from: 'wren',
	ciphertext: 'ct',
	header: { encryptedHeader: 'enc' },
	ts: 1,
});

const handlers = () => ({
	onMessage: vi.fn<(f: WsMessageFrame) => Promise<void>>().mockResolvedValue(undefined),
	onGroupMessage: vi.fn<(f: WsGroupMessageFrame) => Promise<void>>().mockResolvedValue(undefined),
	onDelivered: vi.fn<(f: WsDeliveredFrame) => Promise<void>>().mockResolvedValue(undefined),
});

describe('routeInboundFrame', () => {
	it('routes each known frame type to its handler, with the parsed frame', async () => {
		const h = handlers();
		const frame = messageFrame('m1');

		await routeInboundFrame(JSON.stringify(frame), h)?.();
		expect(h.onMessage).toHaveBeenCalledWith(frame);
		expect(h.onGroupMessage).not.toHaveBeenCalled();
		expect(h.onDelivered).not.toHaveBeenCalled();

		await routeInboundFrame(JSON.stringify({ type: 'delivered', id: 'd1', to: 'wren' }), h)?.();
		expect(h.onDelivered).toHaveBeenCalledWith({ type: 'delivered', id: 'd1', to: 'wren' });

		const group = { type: 'groupMessage', id: 'g1', groupId: 'grp', from: 'wren', ciphertext: 'ct', ts: 1 };
		await routeInboundFrame(JSON.stringify(group), h)?.();
		expect(h.onGroupMessage).toHaveBeenCalledWith(group);
	});

	// A chat view that dies on a malformed frame is a denial of service that any
	// participant — or anything on the wire — can trigger.
	it('returns null for a malformed frame instead of throwing', () => {
		const h = handlers();
		expect(routeInboundFrame('not json at all', h)).toBeNull();
		expect(routeInboundFrame('', h)).toBeNull();
		expect(routeInboundFrame('{"type":', h)).toBeNull();
		expect(h.onMessage).not.toHaveBeenCalled();
	});

	it('ignores frame types it does not know, including non-objects', () => {
		const h = handlers();
		expect(routeInboundFrame(JSON.stringify({ type: 'somethingNew', id: 'x' }), h)).toBeNull();
		expect(routeInboundFrame(JSON.stringify({ id: 'no-type' }), h)).toBeNull();
		expect(routeInboundFrame(JSON.stringify(null), h)).toBeNull();
		expect(routeInboundFrame(JSON.stringify([1, 2, 3]), h)).toBeNull();
		expect(routeInboundFrame(JSON.stringify('a string'), h)).toBeNull();
		expect(h.onMessage).not.toHaveBeenCalled();
	});
});

describe('createSessionOpChain — the offline-flush serialization', () => {
	it('runs a burst strictly one at a time, in arrival order', async () => {
		const { enqueue } = createSessionOpChain();
		const events: string[] = [];
		let inFlight = 0;

		// Deliberately uneven: if the chain leaked concurrency, the shorter tasks
		// would finish out of order and `inFlight` would exceed 1.
		const op = (name: string, delay: number) =>
			enqueue(async () => {
				inFlight += 1;
				expect(inFlight).toBe(1);
				events.push(`start:${name}`);
				await new Promise((r) => setTimeout(r, delay));
				events.push(`end:${name}`);
				inFlight -= 1;
			});

		await Promise.all([op('a', 20), op('b', 1), op('c', 10)]);

		expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
	});

	// The tail must not be poisoned. One undecryptable message in a flush of
	// forty cannot be allowed to silently drop the other thirty-nine.
	it('keeps running later ops after one rejects', async () => {
		const { enqueue } = createSessionOpChain();
		const ran: string[] = [];

		const failing = enqueue(async () => {
			ran.push('boom');
			throw new Error('handler blew up');
		});
		const after = enqueue(async () => {
			ran.push('after');
			return 'ok';
		});

		await expect(failing).rejects.toThrow('handler blew up');
		await expect(after).resolves.toBe('ok');
		expect(ran).toEqual(['boom', 'after']);
	});

	// The failure still has to reach the caller — the outbound send path relies on
	// it to show the user that their message didn't go.
	it('rejects the caller’s promise, not just the chain', async () => {
		const { enqueue } = createSessionOpChain();
		await expect(enqueue(() => Promise.reject(new Error('send failed')))).rejects.toThrow('send failed');
	});

	it('returns the task’s value to the caller', async () => {
		const { enqueue } = createSessionOpChain();
		await expect(enqueue(async () => 42)).resolves.toBe(42);
	});

	// An unhandled rejection anywhere in the chain's internal bookkeeping would
	// surface as a process-level warning and, on some hosts, a crash.
	it('never leaves an unhandled rejection behind', async () => {
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);
		try {
			const { enqueue } = createSessionOpChain();
			// Reject with nobody awaiting the returned promise at all — the case a
			// fire-and-forget inbound handler produces.
			void enqueue(() => Promise.reject(new Error('nobody is listening'))).catch(() => {});
			enqueue(() => Promise.reject(new Error('nor here'))).catch(() => {});
			await new Promise((r) => setTimeout(r, 20));
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off('unhandledRejection', unhandled);
		}
	});
});
