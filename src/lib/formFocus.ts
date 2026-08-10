import type { KeyboardEvent } from 'react';

// Explicit Tab order between two form fields.
//
// WHY THIS IS NEEDED AT ALL, since Tab between inputs is browser-default
// behaviour: in a Mac Catalyst app the web content sits inside UIKit, whose
// focus system claims the Tab key before the DOM ever sees it. So on macOS the
// login form's Tab did nothing — you had to click from Username into Password.
// Typing works, which is what makes it confusing: key events DO reach the field,
// just not this one.
//
// Handling it in JS makes the order deterministic on every platform rather than
// depending on each host's focus engine, and it matches what the app already
// does for dialogs (`useModalDialog` traps Tab the same way). The order it
// enforces is the natural DOM order, so nothing changes on web — it just stops
// being the host's decision.
//
// Modified Tab (ctrl/alt/cmd) is left alone: those are host shortcuts, not field
// navigation, and swallowing them would break e.g. cmd-Tab passthrough.
export function focusOrder({ next, prev }: { next?: string; prev?: string }) {
	return (event: KeyboardEvent<HTMLElement>): void => {
		if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
		const targetId = event.shiftKey ? prev : next;
		if (!targetId) return;
		const target = document.getElementById(targetId);
		if (!target) return;
		event.preventDefault();
		target.focus();
	};
}
