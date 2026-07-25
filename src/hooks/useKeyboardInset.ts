import { useEffect } from 'react';
import { isNativePlatform } from '../lib/platform';

// Mirror the native on-screen keyboard height into `--keyboard-height` on the
// document root while mounted. WKWebView (with Keyboard resize:'none') does NOT
// resize the viewport when the keyboard opens — it just draws over the bottom of
// the page — so without this a page has no way to know it should make room, and
// content under the keyboard can't be scrolled to. A page reads the variable to
// add scroll room / bottom padding. No-op on web (the browser resizes the
// viewport itself). Mirrors the same listener the chat shell runs (Chat.tsx).
export function useKeyboardInset(): void {
	useEffect(() => {
		if (!isNativePlatform()) return;
		const root = document.documentElement;
		let showRemove: (() => void) | undefined;
		let hideRemove: (() => void) | undefined;
		void (async () => {
			const { Keyboard } = await import('@capacitor/keyboard');
			const show = await Keyboard.addListener('keyboardWillShow', (info) => {
				root.style.setProperty('--keyboard-height', `${info.keyboardHeight}px`);
			});
			const hide = await Keyboard.addListener('keyboardWillHide', () => {
				root.style.setProperty('--keyboard-height', '0px');
			});
			showRemove = () => void show.remove();
			hideRemove = () => void hide.remove();
		})();
		return () => {
			showRemove?.();
			hideRemove?.();
			root.style.removeProperty('--keyboard-height');
		};
	}, []);
}
