import { useCallback, useEffect, useRef, useState, type ReactNode, type PointerEvent } from 'react';

// A hand-rolled bottom sheet (no dependency): scrim + a bottom-anchored panel
// with a drag handle, drag-to-dismiss, Esc-to-close, scrim-click-to-close, and
// a focus trap. Everything interactive lives in the bottom of the screen so the
// sheet is reachable one-handed. Content scrolls inside the panel; the page
// behind never scrolls (body overflow is locked while open).
//
// Drag: dragging the panel down past a threshold dismisses it; a short drag
// springs back. Only downward drag moves the panel.

interface BottomSheetProps {
	onClose: () => void;
	children: ReactNode;
	/** id of the element labelling the sheet, for aria-labelledby. */
	labelledBy?: string;
	/** Extra classes for the panel (e.g. an orbit-indigo background). */
	panelClassName?: string;
}

const DISMISS_AFTER = 96; // px dragged down before release dismisses

export const BottomSheet = ({ onClose, children, labelledBy, panelClassName = '' }: BottomSheetProps) => {
	const panelRef = useRef<HTMLDivElement>(null);
	const [dragY, setDragY] = useState(0);
	const dragStart = useRef<number | null>(null);

	// Lock body scroll while open, restore on close.
	useEffect(() => {
		const prev = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.body.style.overflow = prev;
		};
	}, []);

	// Focus the panel on open; Esc closes; Tab is trapped within the sheet.
	useEffect(() => {
		const panel = panelRef.current;
		panel?.focus();
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				onClose();
				return;
			}
			if (e.key !== 'Tab' || !panel) return;
			const focusable = panel.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
			);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			const active = document.activeElement;
			if (e.shiftKey && (active === first || active === panel)) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && active === last) {
				e.preventDefault();
				first.focus();
			}
		};
		document.addEventListener('keydown', onKeyDown);
		return () => document.removeEventListener('keydown', onKeyDown);
	}, [onClose]);

	const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
		dragStart.current = e.clientY;
		e.currentTarget.setPointerCapture(e.pointerId);
	};
	const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
		if (dragStart.current === null) return;
		setDragY(Math.max(0, e.clientY - dragStart.current)); // downward only
	};
	const onPointerUp = useCallback(() => {
		if (dragStart.current === null) return;
		const shouldClose = dragY >= DISMISS_AFTER;
		dragStart.current = null;
		if (shouldClose) onClose();
		else setDragY(0); // spring back
	}, [dragY, onClose]);

	return (
		<div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
			<button className="absolute inset-0 bg-black/40 animate-scrim-in" aria-label="Close" tabIndex={-1} onClick={onClose} />
			<div
				ref={panelRef}
				tabIndex={-1}
				className={`relative animate-sheet-rise max-h-[90dvh] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-crease-line-bold env-safe-bottom env-safe-x focus:outline-none ${
					panelClassName || 'bg-graph-card'
				}`}
				style={dragY ? { transform: `translateY(${dragY}px)` } : undefined}
			>
				{/* Drag handle — also the drag surface. */}
				<div className="pt-2.5 pb-1 flex justify-center cursor-grab touch-none" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
					<span className="block w-10 h-1 rounded-full bg-graphite-40" aria-hidden="true" />
				</div>
				{children}
			</div>
		</div>
	);
};
