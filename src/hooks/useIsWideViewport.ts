import { useEffect, useState } from 'react';
import { WIDE_VIEWPORT_PX } from '../lib/chatChrome';

// True once the viewport is wide enough that the chat shell shows both panes
// side by side, i.e. it is a desktop/tablet layout rather than a phone one.
//
// This mirrors the `min-[900px]:` Tailwind variants in Chat.tsx, and the two are
// kept honest by a drift test — they are two encodings of one number and nothing
// else makes them agree.
//
// Why JS at all, when the layout itself is pure CSS: some chrome cannot be
// solved with a media query, because it is a question of which *component*
// renders, not how it is styled. `showContactsPane` is the clear case — a CSS
// rule can hide the Contacts pane, but the conversation list still would not
// exist to take its place.
export function useIsWideViewport(): boolean {
	const [wide, setWide] = useState(() => matches());

	useEffect(() => {
		if (typeof window.matchMedia !== 'function') return;
		const mql = window.matchMedia(`(min-width: ${WIDE_VIEWPORT_PX}px)`);
		const update = () => setWide(mql.matches);
		update(); // in case it changed between first render and effect
		mql.addEventListener('change', update);
		return () => mql.removeEventListener('change', update);
	}, []);

	return wide;
}

// Resolving on the first render rather than after an effect matters: starting
// `false` would flash the phone chrome on every desktop load. Guarded because
// jsdom (the ui test project) does not implement matchMedia.
function matches(): boolean {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
	return window.matchMedia(`(min-width: ${WIDE_VIEWPORT_PX}px)`).matches;
}
