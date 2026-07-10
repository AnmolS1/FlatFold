import { useEffect, useState } from 'react';

// Keeps the app shell sized to the *visual* viewport so the composer stays
// glued directly above the on-screen keyboard instead of being hidden beneath
// it.
//
// Why this is needed: `100dvh` (the dynamic viewport) does NOT shrink for the
// software keyboard on iOS Safari — the keyboard overlays the page, so a
// bottom-pinned composer ends up underneath it. The `visualViewport` API is
// the only reliable signal for the keyboard-adjusted height there. On Chrome
// Android we additionally set `interactive-widget=resizes-content` in the
// viewport meta, which resizes the layout viewport directly; this hook is a
// no-op harmless there (it just tracks the window height).
//
// Returns the current visual-viewport height in CSS px, or `null` when the API
// is unavailable (older browsers) — callers fall back to a `100dvh` class so
// there is never a white flash: the class holds until the hook resolves to the
// same value.
export function useVisualViewportHeight(): number | null {
	const [height, setHeight] = useState<number | null>(null);

	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;

		let frame = 0;
		const update = () => {
			// Coalesce the burst of resize/scroll events the keyboard animation
			// fires into one measurement per frame.
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => setHeight(vv.height));
		};

		update();
		vv.addEventListener('resize', update);
		vv.addEventListener('scroll', update);
		return () => {
			cancelAnimationFrame(frame);
			vv.removeEventListener('resize', update);
			vv.removeEventListener('scroll', update);
		};
	}, []);

	return height;
}
