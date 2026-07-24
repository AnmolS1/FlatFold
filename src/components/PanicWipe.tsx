import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmationDialog } from './common/ConfirmationDialog';
import { apiLogout } from '../lib/api';
import { PANIC_EVENT, panicWipe } from '../lib/panicWipe';

// Mounted once above the keystore-unlock gate so it works whether the app is
// locked or unlocked, online or offline. Opens on a deliberate two-step:
// either the "Panic wipe" control (which dispatches PANIC_EVENT) or the
// keyboard chord (triple-tap Escape within 1.5s), then a confirm dialog.
const CHORD_KEY = 'Escape';
const CHORD_COUNT = 3;
const CHORD_WINDOW_MS = 1500;
// Touch equivalent of the keyboard chord (no hardware Esc on a phone): rapid
// taps on the FlatFold mark ([data-panic-tap], present even on the locked unlock
// screen). More taps than the keyboard chord so it isn't tripped by fidgeting.
const TOUCH_CHORD_COUNT = 5;
const TOUCH_CHORD_WINDOW_MS = 2000;

export const PanicWipe = () => {
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [wiping, setWiping] = useState(false);
	const tapsRef = useRef<number[]>([]);
	const touchTapsRef = useRef<number[]>([]);

	useEffect(() => {
		const open = () => setConfirmOpen(true);
		window.addEventListener(PANIC_EVENT, open);

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== CHORD_KEY) return;
			const now = Date.now();
			const taps = tapsRef.current.filter((t) => now - t < CHORD_WINDOW_MS);
			taps.push(now);
			tapsRef.current = taps;
			if (taps.length >= CHORD_COUNT) {
				tapsRef.current = [];
				setConfirmOpen(true);
			}
		};
		window.addEventListener('keydown', onKeyDown);

		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Element | null;
			if (!target?.closest('[data-panic-tap]')) return;
			const now = Date.now();
			const taps = touchTapsRef.current.filter((t) => now - t < TOUCH_CHORD_WINDOW_MS);
			taps.push(now);
			touchTapsRef.current = taps;
			if (taps.length >= TOUCH_CHORD_COUNT) {
				touchTapsRef.current = [];
				setConfirmOpen(true);
			}
		};
		window.addEventListener('pointerdown', onPointerDown);

		return () => {
			window.removeEventListener(PANIC_EVENT, open);
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('pointerdown', onPointerDown);
		};
	}, []);

	const handleConfirm = useCallback(async () => {
		setWiping(true);
		await panicWipe(async () => {
			await apiLogout();
		});
		// Hard navigation to clear all in-memory React/JS state too, not just a
		// client-side route change.
		window.location.href = '/login';
	}, []);

	return (
		<ConfirmationDialog
			isOpen={confirmOpen}
			onClose={() => setConfirmOpen(false)}
			onConfirm={() => void handleConfirm()}
			title="Panic wipe this device"
			message="This permanently destroys all FlatFold data on this device — your keys, every message, and all local caches. It cannot be undone, and it does not delete anything you've already sent to others. Continue?"
			confirmText={wiping ? 'Wiping…' : 'Wipe everything'}
			cancelText="Cancel"
			confirmButtonVariant="danger"
			loading={wiping}
		/>
	);
};
