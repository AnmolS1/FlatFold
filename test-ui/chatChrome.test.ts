// The chat shell's chrome rules, and the one invariant they exist to protect:
// **you can always get to Settings.**
//
// This is a regression test for a shipping trap. On a native build at >= 900px,
// opening a conversation left Settings unreachable with no way back — four gates
// in Chat.tsx lined up:
//
//   - the header Settings glyph was hidden on native  (`{!native && …}`)
//   - the tab bar, the only other route, needed `mobileView === 'list'`
//   - at >= 900px both panes render regardless of `mobileView`
//   - the back chevrons that reset `mobileView` are `min-[900px]:hidden`
//
// It is NOT a macOS-only problem: iPad in landscape is 1024-1366pt, so the
// shipping universal build hits it. Portrait on the smaller iPads is under 900,
// which is why it went unnoticed — you rotate, and Settings disappears.
//
// Same shape as the keystore-unlock-gate trap: a state with no exit. So it gets
// the same treatment — the rules move out of JSX into predicates that can be
// enumerated exhaustively, and the invariant is checked over EVERY state rather
// than the one configuration a render test would cover.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
	WIDE_VIEWPORT_PX,
	showBackToList,
	showContactsPane,
	showHeaderSettings,
	showTabBar,
	type ChatChromeState,
} from '../src/lib/chatChrome';

/** Every state the shell can be in. Small enough to enumerate completely. */
function allStates(): ChatChromeState[] {
	const states: ChatChromeState[] = [];
	for (const native of [true, false])
		for (const wide of [true, false])
			for (const mobileView of ['list', 'conversation'] as const)
				for (const composeOpen of [true, false])
					for (const activeTab of ['chats', 'contacts', 'settings'] as const)
						states.push({ native, wide, mobileView, composeOpen, activeTab });
	return states;
}

const describeState = (s: ChatChromeState) =>
	`${s.native ? 'native' : 'web'}/${s.wide ? 'wide' : 'narrow'}/${s.mobileView}/${s.composeOpen ? 'composing' : 'idle'}/${s.activeTab}`;

/**
 * Can the user reach Settings from here, in any number of steps?
 *
 * A breadth-first walk rather than a one-shot check, because "reachable" is the
 * real requirement — on a phone, being in a conversation legitimately hides the
 * tab bar, and that is fine precisely because a back control exists. What is not
 * fine is a state with no outgoing edge to any state that shows a route.
 *
 * Deliberately modelled in the TEST, not in production code: the app doesn't
 * need to compute reachability, it just must not violate it.
 */
function settingsReachable(start: ChatChromeState): boolean {
	const seen = new Set<string>();
	const queue: ChatChromeState[] = [start];
	while (queue.length) {
		const s = queue.shift()!;
		const key = describeState(s);
		if (seen.has(key)) continue;
		seen.add(key);

		if (showHeaderSettings(s) || showTabBar(s)) return true;

		// Edges the user can actually take from here.
		if (showBackToList(s)) queue.push({ ...s, mobileView: 'list' });
		if (s.composeOpen) queue.push({ ...s, composeOpen: false }); // compose is dismissable
	}
	return false;
}

describe('chat chrome', () => {
	it('Settings is reachable from EVERY state — no dead ends', () => {
		const trapped = allStates().filter((s) => !settingsReachable(s)).map(describeState);
		expect(trapped).toEqual([]);
	});

	// The bug reported from the Mac, stated as its own case so a regression names
	// itself rather than hiding in the exhaustive sweep above.
	it('native + wide + in a conversation still offers Settings (the reported bug)', () => {
		const s: ChatChromeState = { native: true, wide: true, mobileView: 'conversation', composeOpen: false, activeTab: 'chats' };
		expect(showHeaderSettings(s)).toBe(true);
	});

	it('Contacts stays reachable too — the fix must not trade one dead end for another', () => {
		// The native Contacts pane is only ever opened from the tab bar. If wide
		// native hides the tab bar (it does — that is the desktop layout), the pane
		// must not be what renders, or there is no control left to leave it.
		const wideNative: ChatChromeState = { native: true, wide: true, mobileView: 'list', composeOpen: false, activeTab: 'contacts' };
		expect(showTabBar(wideNative)).toBe(false);
		expect(showContactsPane(wideNative)).toBe(false); // falls back to the desktop contact list
	});

	it('keeps the phone layout unchanged', () => {
		const phoneList: ChatChromeState = { native: true, wide: false, mobileView: 'list', composeOpen: false, activeTab: 'chats' };
		expect(showTabBar(phoneList)).toBe(true);
		expect(showHeaderSettings(phoneList)).toBe(false); // D2: cap header actions on phones

		// In a conversation the tab bar goes away, as designed — the back chevron
		// is what makes that legal.
		const phoneConvo: ChatChromeState = { ...phoneList, mobileView: 'conversation' };
		expect(showTabBar(phoneConvo)).toBe(false);
		expect(showBackToList(phoneConvo)).toBe(true);
	});

	it('the web layout is unchanged: header glyph at any width, never a tab bar', () => {
		for (const wide of [true, false]) {
			const s: ChatChromeState = { native: false, wide, mobileView: 'list', composeOpen: false, activeTab: 'chats' };
			expect(showHeaderSettings(s)).toBe(true);
			expect(showTabBar(s)).toBe(false);
		}
	});

	// `showBackToList` is the one predicate that models a rule enforced in CSS
	// rather than by this module — the reachability walk above leans on it, so if
	// the markup ever stopped hiding the back chevron on wide (or started hiding
	// it on narrow), the walk would be reasoning about an app that no longer
	// exists and could report "reachable" for a state that traps you.
	it('the back chevrons really are wide-hidden, which is what showBackToList claims', () => {
		const chat = readFileSync(resolvePath(process.cwd(), 'src/pages/Chat.tsx'), 'utf8');
		const backButtons = [...chat.matchAll(/aria-label="Back to conversations"/g)];
		expect(backButtons.length).toBeGreaterThan(0);
		// Every back control must carry the wide-hidden variant at the breakpoint.
		const wideHidden = [...chat.matchAll(new RegExp(`min-\\[${WIDE_VIEWPORT_PX}px\\]:hidden`, 'g'))];
		expect(wideHidden.length).toBe(backButtons.length);
	});

	// The JS breakpoint and the Tailwind arbitrary variants are two encodings of
	// one number, and nothing makes them agree. This is the same idea as the
	// existing users-table/transparency schema-drift test.
	it('WIDE_VIEWPORT_PX matches every min-[…px] utility in the app', () => {
		const found = new Set<string>();
		const walk = (dir: string) => {
			for (const entry of readdirSync(resolvePath(process.cwd(), dir), { withFileTypes: true })) {
				const path = `${dir}/${entry.name}`;
				if (entry.isDirectory()) walk(path);
				else if (/\.tsx?$/.test(entry.name)) {
					for (const [, px] of readFileSync(resolvePath(process.cwd(), path), 'utf8').matchAll(/min-\[(\d+)px\]/g)) found.add(px);
				}
			}
		};
		walk('src');
		expect([...found].sort()).toEqual([String(WIDE_VIEWPORT_PX)]);
	});
});
