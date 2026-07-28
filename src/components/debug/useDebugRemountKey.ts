import { useEffect, useState } from 'react';

/**
 * A key that a probe can bump to force the conversation view to REMOUNT.
 *
 * Bumping a `key` is the one thing that reliably makes React unmount a subtree
 * and render it fresh, and a fresh render is exactly what the round-5 model
 * says a media element needs in order to be granted a loader. Three attempts to
 * trigger this from outside the app all failed to unmount anything — a tab
 * button that matched no element, `history.back()` which did not change the
 * route, and a synthetic popstate the router ignored — so the app has to offer
 * the hook rather than have it guessed at from the DOM.
 *
 * DEBUG-gated like the component above: inert on web, and absent from
 * TestFlight and the App Store. Delete with the rest of this file once the Mac
 * playback question is settled.
 */
export const useDebugRemountKey = (): number => {
	const [n, setN] = useState(0);
	useEffect(() => {
		if (!(window as unknown as { __flatfoldDebug?: boolean }).__flatfoldDebug) return;
		const bump = () => setN((v) => v + 1);
		window.addEventListener('flatfold:exp-remount', bump);
		return () => window.removeEventListener('flatfold:exp-remount', bump);
	}, []);
	return n;
};
