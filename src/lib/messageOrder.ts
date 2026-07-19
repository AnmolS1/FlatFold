// Conversation ordering.
//
// The server only ever holds minute-granularity time: `worker/mailbox.ts`
// coarsens every envelope `ts` to `floor(now / 60_000) * 60_000` (invariant #5,
// and the /transparency claim). That's deliberate and must not change — but it
// means the envelope `ts` is useless as a sort key, because every received
// message collapses to the top of its minute (`:00.000`) while the sender's own
// optimistic copy keeps its exact `Date.now()`. Within one minute a message you
// received at `:30` would sort ahead of one you sent at `:10`.
//
// So the SENDER tells the RECIPIENT the precise send time end-to-end: `sentAt`
// rides inside the AEAD-encrypted ChatPayload, which the server never decrypts.
// Both endpoints then order by the same millisecond clock and the server learns
// nothing it didn't already know.
//
// Accepted tradeoff: ordering follows the sender's clock (the same model Signal
// and iMessage use). Clock skew across two devices can still misorder messages
// sent within a few seconds of each other. A server-side global order would
// require precise server timestamps we deliberately don't keep.

import type { DisplayMessage } from '../types';

/**
 * The timestamp a received message should be ordered by: the sender's precise
 * `sentAt` when the payload carried one, else the minute-coarsened envelope
 * `ts`. The fallback keeps legacy and in-flight messages working, degrading
 * only those to the old minute-collapse behavior.
 *
 * Note this is a SORT key, not a display value — `formatTimestamp` renders at
 * minute granularity either way, so no new precision is shown in the UI.
 */
export function displayTsFor(sentAt: number | undefined, envelopeTs: number): number {
	return sentAt ?? envelopeTs;
}

/**
 * The messages to render for a conversation: unexpired (disappearing-messages
 * filter) and in send order.
 */
export function orderedVisibleMessages(messages: readonly DisplayMessage[], now: number): DisplayMessage[] {
	return messages.filter((m) => m.expiresAt === undefined || m.expiresAt > now).sort((a, b) => a.ts - b.ts);
}
