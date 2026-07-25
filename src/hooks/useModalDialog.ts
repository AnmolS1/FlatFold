import { useEffect, useRef } from 'react';

// The behavior every modal surface owes a keyboard or screen-reader user:
// focus moves in on open, Tab can't wander out to the page behind, Escape
// closes, focus returns to whatever opened it, and the page behind doesn't
// scroll. Shared by the bottom sheet and the centred dialogs so they can't
// drift apart — the sheets had most of this and the dialogs had none of it.
//
// Pair the returned ref with role="dialog" aria-modal="true" and an
// aria-labelledby pointing at the title; the ARIA attributes are the caller's
// because the markup differs per surface.

const FOCUSABLE =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useModalDialog<T extends HTMLElement>(onClose: () => void) {
	const panelRef = useRef<T>(null);
	// Callers pass a fresh `onClose` closure on every render (e.g.
	// `onClose={() => setOpen(false)}`). Route it through a ref so the focus/trap
	// effect can stay a run-ONCE effect: re-running it on each new closure would
	// re-focus the first control and yank focus off whatever input the user is
	// typing in — which, on iOS, dismisses the keyboard mid-entry.
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// Lock body scroll while open, restore on close.
	useEffect(() => {
		const previous = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.body.style.overflow = previous;
		};
	}, []);

	// Remember what had focus so it can be handed back on close. Captured on
	// mount, before focus moves into the panel — otherwise a keyboard user is
	// dumped at the top of the document every time they dismiss a dialog.
	useEffect(() => {
		const opener = document.activeElement as HTMLElement | null;
		return () => {
			// The trigger may have unmounted with the dialog; only restore if it's
			// still in the document and still focusable.
			if (opener && document.contains(opener)) opener.focus();
		};
	}, []);

	// Move focus in ONCE on open, then close on Escape and cycle Tab within the
	// panel. Deliberately a mount-only effect (see onCloseRef above): focus-in
	// must not repeat when the parent re-renders, or it steals focus from a
	// focused input and drops the on-screen keyboard.
	useEffect(() => {
		const panel = panelRef.current;
		// Prefer the first focusable control; fall back to the panel itself so
		// focus is inside the dialog either way.
		const firstFocusable = panel?.querySelector<HTMLElement>(FOCUSABLE);
		(firstFocusable ?? panel)?.focus();

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				onCloseRef.current();
				return;
			}
			if (e.key !== 'Tab' || !panel) return;

			const focusable = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
			if (focusable.length === 0) {
				// Nothing to tab to — keep focus pinned to the panel rather than
				// letting it escape to the page behind.
				e.preventDefault();
				panel.focus();
				return;
			}
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			const active = document.activeElement;
			// Wrap at both ends, and treat focus sitting on the panel itself as
			// being at the start.
			if (e.shiftKey && (active === first || active === panel)) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && active === last) {
				e.preventDefault();
				first.focus();
			} else if (active && !panel.contains(active)) {
				// Focus somehow left the panel (browser chrome, a stray programmatic
				// focus) — pull it back rather than letting Tab continue outside.
				e.preventDefault();
				first.focus();
			}
		};

		document.addEventListener('keydown', onKeyDown);
		return () => document.removeEventListener('keydown', onKeyDown);
	}, []);

	return panelRef;
}
