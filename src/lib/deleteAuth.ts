// Authorization for "delete for everyone" (remote retraction). This is the
// security-critical check: an inbound delete-control payload may ONLY retract a
// message the SENDER themselves sent — never one of ours, never a third
// party's. Kept as a pure, unit-tested function so the invariant is verifiable
// in isolation from the receive path.
//
// The CALLER is responsible for the other half of the invariant: it must look
// `target` up ONLY within the sender's own conversation (message history keyed
// by the frame's sender), not across all conversations. This function then
// confirms the found message was actually authored by that sender.

import type { DisplayMessage } from '../types';

export function canDelete(target: DisplayMessage | undefined, frameSender: string): boolean {
	// No such message (unknown / already hard-deleted / expired) → not
	// authorized, and the caller treats it as a silent, still-acked no-op.
	if (!target) return false;
	// The retraction is only valid for a message the requester authored.
	return target.from === frameSender;
}
