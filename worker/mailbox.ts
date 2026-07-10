// Mailbox Durable Object — one instance per user, addressed by username.
//
// Delivery model (M3 Phase 2): at-least-once with idempotent receive.
// - Live delivery when the recipient's socket is connected (never stored).
// - Otherwise the ciphertext envelope is queued in DO storage and flushed
//   on the recipient's next connect.
// - A queued envelope is deleted only when the recipient ACKS it (confirms
//   it decrypted+persisted), NOT merely when it was flushed to a socket —
//   so a drop between flush and processing can't lose it. The tradeoff is
//   that a message can be delivered more than once (ack lost, reconnect
//   mid-flush); the client dedupes by id (src/lib/messaging.ts) and re-acks,
//   so redelivery is harmless.
// - On ack, the recipient's DO also fires a best-effort, LIVE-ONLY
//   'delivered' notification back to the sender. If the sender is offline it
//   is dropped, not queued — delivery receipts are cosmetic, not durable.
// - Queued envelopes are hard-TTL'd at 14 days via a DO alarm, regardless of
//   whether they were ever delivered (invariant #2).

import { DurableObject } from 'cloudflare:workers';
import { sendWakeupToUser } from './push';
import type {
	WsAckFrame,
	WsClientToServerFrame,
	WsDeliveredFrame,
	WsEnvelope,
	WsGroupMessageFrame,
	WsGroupSendFrame,
	WsMessageFrame,
	WsSendFrame,
} from '../shared/types';

interface WsAttachment {
	username: string;
}

const ENVELOPE_PREFIX = 'envelope:';
const SEND_SEQ_KEY = 'sendSeq';
// Sealed sender: the DO holds the set of currently-valid delivery tokens for
// its owner (the owner registers them; contacts present one to deliver without
// authenticating). A small set gives a rotation grace window (new + previous).
const SEAL_TOKENS_KEY = 'sealTokens';
const MAX_SEAL_TOKENS = 3;
// Sealed envelopes carry no `from` (that's the point), so they can't use the
// per-sender send-seq for flush order — they use a receive-order counter on
// the recipient's DO. Per-sender order is the ratchet's job; cross-sender
// order is irrelevant. Keyed distinctly (numeric first segment) from legacy
// `envelope:{from}:...`.
const RECV_SEQ_KEY = 'recvSeq';
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
const TTL_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
// Flooding / storage-cost guards (H2). Delivery tokens are public and any authed
// user can send to any username, so the offline queue is an untrusted-write sink:
// cap the number of queued envelopes per mailbox and the size of any one envelope
// (text frames only — media rides R2, not the queue), and reject oversized raw WS
// frames before parsing. When a cap is hit the INCOMING write is dropped (never
// evict existing messages), and callers still return the uniform response so this
// stays non-oracle.
const MAX_QUEUED_ENVELOPES = 500;
const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_WS_FRAME_BYTES = 128 * 1024;

// Queued-envelope key: `envelope:{from}:{paddedSeq}:{id}`. `ctx.storage.list()`
// returns keys in ascending UTF-8 order, so the zero-padded per-sender
// monotonic seq makes flush order match send order within each sender —
// which is load-bearing, not cosmetic: X3DH handshake material rides only on
// a session's first message, so a later message flushing first would arrive
// with no session to decrypt it (the client handles that as a retry, but
// correct ordering avoids the round-trip and a transient error). `seq` is
// used only here; the envelope's own `ts` is coarsened to the minute.
function envelopeStorageKey(envelope: WsEnvelope): string {
	return `${ENVELOPE_PREFIX}${envelope.from}:${String(envelope.seq).padStart(12, '0')}:${envelope.id}`;
}

export class Mailbox extends DurableObject<Env> {
	// Serializes outbound sends from this DO's owner so send-order seq
	// assignment and cross-DO delivery happen one at a time (v1 is
	// single-device, so there's only ever one socket driving this). Lost on
	// hibernation eviction, but `sendSeq` is storage-backed, so a cold start
	// simply continues the sequence.
	private sendChain: Promise<void> = Promise.resolve();
	private sendSeq?: number;

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Internal DO-to-DO calls — only reachable via this Worker's own
		// `env.MAILBOX.getByName().fetch()` (these DOs have no public URL of
		// their own), so the binding boundary is the trust boundary.
		if (url.pathname === '/deliver' && request.method === 'POST') {
			return this.handleDeliver(request);
		}
		if (url.pathname === '/delivered' && request.method === 'POST') {
			return this.handleDeliveredNotification(request);
		}
		if (url.pathname === '/purge' && request.method === 'POST') {
			return this.handlePurge();
		}
		if (url.pathname === '/register-token' && request.method === 'POST') {
			return this.handleRegisterToken(request);
		}
		if (url.pathname === '/sealed-deliver' && request.method === 'POST') {
			return this.handleSealedDeliver(request);
		}

		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected websocket upgrade', { status: 426 });
		}

		const username = request.headers.get('X-Authenticated-User');
		if (!username) return new Response('Missing authenticated user.', { status: 401 });

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];

		// Hibernation API: the runtime can evict this DO from memory between
		// messages and still redeliver `webSocketMessage`/`webSocketClose`. A
		// plain instance field wouldn't survive that, so the owning username
		// is stored via serializeAttachment/deserializeAttachment.
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ username } satisfies WsAttachment);

		this.ctx.waitUntil(this.flushQueued(server));

		return new Response(null, { status: 101, webSocket: client });
	}

	// Account deletion (invariant #6): synchronously wipe THIS user's mailbox —
	// every queued ciphertext envelope and the send-seq counter — cancel the
	// TTL alarm, and close any live socket. Only the user's OWN DO is purged;
	// envelopes this user sent that sit in OTHER users' mailboxes are ciphertext
	// addressed to those recipients (not this user's data) and are left for
	// normal ack/TTL deletion.
	private async handlePurge(): Promise<Response> {
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm();
		this.sendSeq = undefined; // force a reload-from-(now-empty)-storage next send
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(1000, 'account deleted');
			} catch {
				/* already closing */
			}
		}
		return new Response(null, { status: 204 });
	}

	private async handleDeliver(request: Request): Promise<Response> {
		const { recipient, envelope } = (await request.json()) as { recipient: string; envelope: WsEnvelope };
		const sockets = this.ctx.getWebSockets();

		if (sockets.length > 0) {
			// Live delivery: sent directly, never persisted. The recipient
			// still acks it (to fire the delivered receipt); that ack simply
			// finds nothing queued to delete.
			const payload = JSON.stringify(envelope);
			for (const ws of sockets) ws.send(payload);
		} else if (await this.canQueue(envelope)) {
			await this.ctx.storage.put(envelopeStorageKey(envelope), envelope);
			await this.ensureTtlAlarm();
			// Recipient is offline — fire a CONTENT-FREE wake-up push (no text,
			// no sender). Best-effort; the client re-syncs on reconnect anyway.
			this.ctx.waitUntil(sendWakeupToUser(this.env, recipient));
		}
		// Over cap / oversized → dropped; still 204 (non-oracle, see canQueue).
		return new Response(null, { status: 204 });
	}

	// H2: may this envelope be queued? Rejects when it would exceed the per-envelope
	// size cap or the per-mailbox queue cap. Drops the INCOMING write rather than
	// evicting existing envelopes, so a flooder can't push a victim's real messages
	// out. `list({limit})` bounds the count read to the cap.
	private async canQueue(envelope: unknown): Promise<boolean> {
		const size = new TextEncoder().encode(JSON.stringify(envelope)).length;
		if (size > MAX_ENVELOPE_BYTES) return false;
		const queued = await this.ctx.storage.list({ prefix: ENVELOPE_PREFIX, limit: MAX_QUEUED_ENVELOPES });
		return queued.size < MAX_QUEUED_ENVELOPES;
	}

	// The owner registers a delivery token with their own DO (authenticated on
	// the Worker before this internal call). Newest-first, capped — the tail
	// entries are the previous tokens, kept briefly so in-flight sends during a
	// rotation still validate.
	private async handleRegisterToken(request: Request): Promise<Response> {
		const { token } = (await request.json()) as { token?: unknown };
		if (typeof token !== 'string' || token.length < 16) return new Response('bad token', { status: 400 });
		const tokens = (await this.ctx.storage.get<string[]>(SEAL_TOKENS_KEY)) ?? [];
		const next = [token, ...tokens.filter((t) => t !== token)].slice(0, MAX_SEAL_TOKENS);
		await this.ctx.storage.put(SEAL_TOKENS_KEY, next);
		return new Response(null, { status: 204 });
	}

	// Token-gated delivery of a sealed send. The sender is unknown here (the
	// gateway never learned it); we validate only that the presenter holds a
	// currently-valid token for this recipient, then deliver the (from-less)
	// envelope. Invalid token → 403, but the gateway returns a uniform 202
	// regardless, so this is not an oracle.
	private async handleSealedDeliver(request: Request): Promise<Response> {
		const { token, envelope, recipient } = (await request.json()) as {
			token?: unknown;
			// A from-less 1:1 message (increment 5) OR a sealed delivered-receipt
			// (increment 6). Both carry an `id`, which keys the offline queue.
			envelope?: WsEnvelope | WsDeliveredFrame;
			recipient?: unknown;
		};
		if (typeof token !== 'string' || !envelope) return new Response('bad request', { status: 400 });
		const tokens = (await this.ctx.storage.get<string[]>(SEAL_TOKENS_KEY)) ?? [];
		if (!tokens.includes(token)) return new Response('forbidden', { status: 403 });

		const sockets = this.ctx.getWebSockets();
		if (sockets.length > 0) {
			const payload = JSON.stringify(envelope);
			for (const ws of sockets) ws.send(payload);
		} else if (await this.canQueue(envelope)) {
			// Queued (not live-only) so a briefly-offline sender still learns
			// delivery on reconnect — the load-bearing reason increment 6's signal is
			// reliable. recvSeq already makes the key unique; `id` disambiguates.
			// (canQueue checked BEFORE consuming a recvSeq so a drop leaves no gap.)
			const key = `${ENVELOPE_PREFIX}${String(await this.nextRecvSeq()).padStart(12, '0')}:${envelope.id ?? ''}`;
			await this.ctx.storage.put(key, envelope);
			await this.ensureTtlAlarm();
			// Content-free wake-up push (no sender, no text). `recipient` comes
			// from the gateway, which knows it (routing target) but not the sender.
			if (typeof recipient === 'string') this.ctx.waitUntil(sendWakeupToUser(this.env, recipient));
		}
		// Over cap / oversized → dropped; uniform 204 regardless (non-oracle).
		return new Response(null, { status: 204 });
	}

	private async nextRecvSeq(): Promise<number> {
		const seq = (await this.ctx.storage.get<number>(RECV_SEQ_KEY)) ?? 0;
		await this.ctx.storage.put(RECV_SEQ_KEY, seq + 1);
		return seq;
	}

	// Re-sends every queued envelope on reconnect WITHOUT deleting it —
	// deletion is ack-gated (see handleAck). Redelivery is safe: the client
	// dedupes by id and re-acks.
	private async flushQueued(ws: WebSocket): Promise<void> {
		const stored = await this.ctx.storage.list<WsEnvelope>({ prefix: ENVELOPE_PREFIX });
		for (const [, envelope] of stored) {
			ws.send(JSON.stringify(envelope));
		}
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
		if (typeof message !== 'string') return; // no binary frames in this protocol
		if (message.length > MAX_WS_FRAME_BYTES) return; // H2: drop oversized frames before parsing

		let frame: WsClientToServerFrame;
		try {
			frame = JSON.parse(message);
		} catch {
			return;
		}

		const attachment = ws.deserializeAttachment() as WsAttachment | null;
		if (!attachment) return;

		if (frame.type === 'send' && typeof frame.to === 'string') {
			// Chain sends so seq assignment + delivery stay strictly ordered.
			this.sendChain = this.sendChain.then(() => this.handleSend(attachment.username, frame as WsSendFrame));
			this.ctx.waitUntil(this.sendChain);
		} else if (frame.type === 'groupSend' && typeof frame.to === 'string') {
			this.sendChain = this.sendChain.then(() => this.handleGroupSend(attachment.username, frame as WsGroupSendFrame));
			this.ctx.waitUntil(this.sendChain);
		} else if (frame.type === 'ack' && typeof frame.messageId === 'string') {
			// `to` is a string on the normal path and absent for a sealed message —
			// handleAck deletes the queued copy either way, reverse-hopping only
			// when it knows the sender.
			this.ctx.waitUntil(this.handleAck(attachment.username, frame as WsAckFrame));
		}
	}

	private async handleSend(from: string, frame: WsSendFrame): Promise<void> {
		const envelope: WsMessageFrame = {
			type: 'message',
			id: typeof frame.id === 'string' ? frame.id : crypto.randomUUID(),
			from,
			ciphertext: frame.ciphertext,
			header: frame.header,
			x3dh: frame.x3dh,
			// Coarsened to the minute (invariant #5) — this is the only
			// timestamp persisted/displayed. Send order is carried by `seq`.
			ts: Math.floor(Date.now() / ONE_MINUTE_MS) * ONE_MINUTE_MS,
			seq: await this.nextSendSeq(),
		};

		await this.deliverTo(frame.to, envelope);
	}

	// A single fan-out copy of a group content message. The server treats it
	// like any other envelope (opaque ciphertext); it just carries group
	// fields instead of a ratchet header. `id` is client-generated and shared
	// across all fan-out copies of the same logical message.
	private async handleGroupSend(from: string, frame: WsGroupSendFrame): Promise<void> {
		const envelope: WsGroupMessageFrame = {
			type: 'groupMessage',
			id: frame.id,
			from,
			groupId: frame.groupId,
			iteration: frame.iteration,
			ciphertext: frame.ciphertext,
			signature: frame.signature,
			ts: Math.floor(Date.now() / ONE_MINUTE_MS) * ONE_MINUTE_MS,
			seq: await this.nextSendSeq(),
		};
		await this.deliverTo(frame.to, envelope);
	}

	private async nextSendSeq(): Promise<number> {
		if (this.sendSeq === undefined) {
			this.sendSeq = (await this.ctx.storage.get<number>(SEND_SEQ_KEY)) ?? 0;
		}
		const seq = this.sendSeq;
		this.sendSeq = seq + 1;
		await this.ctx.storage.put(SEND_SEQ_KEY, this.sendSeq);
		return seq;
	}

	private async deliverTo(recipientUsername: string, envelope: WsEnvelope): Promise<void> {
		const stub = this.env.MAILBOX.getByName(recipientUsername);
		await stub.fetch('https://internal/deliver', {
			method: 'POST',
			body: JSON.stringify({ recipient: recipientUsername, envelope }),
		});
	}

	// The recipient acked `messageId`: delete the queued copy (if any) and, on
	// the normal path, tell the original sender it was delivered. `frame.to` is
	// the sender the receipt goes to; the acker's own username (from the socket
	// attachment, not client-claimed) is what the sender sees as the origin.
	// For a SEALED (from-less) message `frame.to` is absent — we don't know the
	// sender — so we delete our own queued copy and skip the reverse hop entirely
	// (a sealed delivered-receipt is a separate, later mechanism).
	private async handleAck(ackerUsername: string, frame: WsAckFrame): Promise<void> {
		const stored = await this.ctx.storage.list<WsMessageFrame>({ prefix: ENVELOPE_PREFIX });
		for (const [key, envelope] of stored) {
			if (envelope.id === frame.messageId) {
				await this.ctx.storage.delete(key);
				break;
			}
		}

		if (frame.to === undefined) return; // sealed message — no sender to notify
		const senderStub = this.env.MAILBOX.getByName(frame.to);
		await senderStub.fetch('https://internal/delivered', {
			method: 'POST',
			body: JSON.stringify({ messageId: frame.messageId, from: ackerUsername }),
		});
	}

	private async handleDeliveredNotification(request: Request): Promise<Response> {
		const { messageId, from } = (await request.json()) as { messageId: string; from: string };
		const deliveredFrame: WsDeliveredFrame = { type: 'delivered', messageId, from };
		const payload = JSON.stringify(deliveredFrame);
		// Best-effort, live-only: if the sender is offline the receipt is
		// dropped, not queued. Delivery receipts are cosmetic.
		for (const ws of this.ctx.getWebSockets()) ws.send(payload);
		return new Response(null, { status: 204 });
	}

	private async ensureTtlAlarm(): Promise<void> {
		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + TTL_SWEEP_INTERVAL_MS);
		}
	}

	// DO alarms are one-shot — reschedule at the end as long as anything
	// remains queued. Deletes envelopes whose (minute-coarsened) ts is older
	// than the 14-day hard TTL, delivered or not.
	async alarm(): Promise<void> {
		const cutoff = Date.now() - TTL_MS;
		const stored = await this.ctx.storage.list<WsMessageFrame>({ prefix: ENVELOPE_PREFIX });
		let remaining = 0;
		for (const [key, envelope] of stored) {
			if (envelope.ts < cutoff) {
				await this.ctx.storage.delete(key);
			} else {
				remaining++;
			}
		}
		if (remaining > 0) {
			await this.ctx.storage.setAlarm(Date.now() + TTL_SWEEP_INTERVAL_MS);
		}
	}

	webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
		// 1005 ("no status received") and 1006 ("abnormal closure") are
		// reserved values the platform uses to REPORT a close with no/abnormal
		// code — passing either back into `close()` explicitly throws
		// InvalidAccessError. Fall back to 1000 (normal closure) for those.
		const isReusableCode = wasClean && code !== 1005 && code !== 1006;
		ws.close(isReusableCode ? code : 1000, reason);
	}
}
