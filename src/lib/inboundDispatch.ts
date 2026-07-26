import type { WsDeliveredFrame, WsGroupMessageFrame, WsMessageFrame } from '../types';

// The two pieces the chat socket's inbound path is built from, lifted out of
// Chat.tsx so they can be tested (FULL_AUDIT_2 R1). They were inline in the
// `ws.onmessage` effect of a 1,751-line component with no test at all, which is
// exactly where the audit and STATUS both expect undiscovered bugs to be.
//
// This is NOT the D2 extraction of useMailboxSocket / useConversationState —
// that is still to come. It is the minimum that makes the frame routing and the
// serialization testable, with the behaviour unchanged.

export interface InboundFrameHandlers {
	onMessage: (frame: WsMessageFrame) => Promise<void>;
	onGroupMessage: (frame: WsGroupMessageFrame) => Promise<void>;
	onDelivered: (frame: WsDeliveredFrame) => Promise<void>;
}

/**
 * Parses one raw WebSocket payload and returns the task that handles it, or
 * null if there is nothing to do.
 *
 * Null covers three cases deliberately, and all three are "carry on", never
 * "throw": a payload that isn't JSON, a payload that is JSON but not an object
 * (`null`, an array, a bare string), and a `type` this client doesn't know.
 * Anything that can reach the socket can otherwise take the chat view down —
 * and an unknown type is what a newer server looks like, so tolerating it is
 * forward compatibility, not just defensiveness.
 */
export function routeInboundFrame(raw: string, handlers: InboundFrameHandlers): (() => Promise<void>) | null {
	let frame: unknown;
	try {
		frame = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return null;

	switch ((frame as { type?: unknown }).type) {
		case 'message':
			return () => handlers.onMessage(frame as WsMessageFrame);
		case 'groupMessage':
			return () => handlers.onGroupMessage(frame as WsGroupMessageFrame);
		case 'delivered':
			return () => handlers.onDelivered(frame as WsDeliveredFrame);
		default:
			return null;
	}
}

export interface SessionOpChain {
	/** Runs `task` after every previously-enqueued op has settled. */
	enqueue: <T>(task: () => Promise<T>) => Promise<T>;
}

/**
 * Serializes every session-touching operation — inbound decrypt AND outbound
 * encrypt — onto a single chain.
 *
 * Both paths do loadSession → mutate → saveSession against IndexedDB, and
 * saveSession rewrites the WHOLE record. Two overlapping ops therefore clobber
 * each other's ratchet state: harmless within a single chain step, but across a
 * DH-ratchet step it wedges the session permanently — a conversation that can
 * never decrypt again. The two ways that happens in practice are a reconnect
 * flush (the mailbox DO redelivers its whole queue as one burst) and a send
 * crossing a receive when both people type at once. Mirrors the sender-side
 * send chain in worker/mailbox.ts.
 *
 * Two properties, and they pull in opposite directions:
 *  - the chain TAIL must never reject, or one failed op poisons every op after
 *    it — thirty-nine good messages dropped because the fortieth was corrupt;
 *  - the promise handed BACK must still reject, because the send path shows the
 *    user that their message didn't go.
 * Hence the two separate `.then` chains below rather than one.
 */
export function createSessionOpChain(): SessionOpChain {
	let tail: Promise<unknown> = Promise.resolve();

	return {
		enqueue<T>(task: () => Promise<T>): Promise<T> {
			// `then(task, task)` — run regardless of how the previous op settled.
			const result = tail.then(task, task);
			tail = result.then(
				() => {},
				() => {}
			);
			return result;
		},
	};
}
