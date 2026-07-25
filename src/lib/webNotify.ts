// Web-only surfacing of inbound activity when the tab is not focused: a "new
// message" marker on the browser tab (title dot + a best-effort favicon badge)
// and, if the user already granted notification permission for Web Push, a
// browser notification.
//
// CONTENT-FREE BY DESIGN. Like the decoy Web Push, none of this reveals who
// messaged or what they said — the tab shows a dot, the notification shows only
// the user's decoy label ("New activity" by default). An OS notification that
// leaked the sender or text would quietly undo the E2EE privacy model, so it
// stays a bare "something happened" signal. Native (capacitor://) never uses
// this; iOS surfaces activity through content-free APNs instead.
import { getDecoyLabel } from './push';
import { isNativePlatform } from './platform';

let unread = false;
let originalTitle: string | null = null;

let iconLink: HTMLLinkElement | null = null;
let originalIconHref: string | null = null;
let originalIconType: string | null = null;
let badgedIconUrl: string | null = null;

function iconEl(): HTMLLinkElement | null {
	if (iconLink) return iconLink;
	iconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
	if (iconLink) {
		originalIconHref = iconLink.getAttribute('href');
		originalIconType = iconLink.getAttribute('type');
	}
	return iconLink;
}

// Draw the current favicon with a small accent dot in the corner, once, and
// cache the data URL. Best-effort: a favicon that can't be drawn (e.g. a
// dimensionless SVG in some browsers) just leaves the reliable title dot in
// place. Never throws.
async function buildBadgedIcon(): Promise<string | null> {
	if (badgedIconUrl) return badgedIconUrl;
	const href = originalIconHref;
	if (!href) return null;
	try {
		const img = await new Promise<HTMLImageElement>((resolve, reject) => {
			const i = new Image();
			i.width = 64;
			i.height = 64;
			i.onload = () => resolve(i);
			i.onerror = () => reject(new Error('icon load failed'));
			i.src = href;
		});
		const size = 64;
		const canvas = document.createElement('canvas');
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.drawImage(img, 0, 0, size, size);
		const r = size * 0.24;
		ctx.beginPath();
		ctx.arc(size - r, r, r, 0, Math.PI * 2);
		ctx.fillStyle = '#E84A27'; // crane — matches the "disconnected"/attention accent
		ctx.fill();
		ctx.lineWidth = size * 0.08;
		ctx.strokeStyle = '#ffffff';
		ctx.stroke();
		badgedIconUrl = canvas.toDataURL('image/png');
		return badgedIconUrl;
	} catch {
		return null;
	}
}

// Mark the tab as having unread activity. Idempotent — a burst of messages while
// away collapses to a single dot.
export function flagUnread(): void {
	if (unread) return;
	unread = true;
	if (originalTitle === null) originalTitle = document.title;
	document.title = `● ${originalTitle}`;
	const link = iconEl();
	if (link) {
		void buildBadgedIcon().then((url) => {
			// Only apply if we're still unread by the time the draw resolves.
			if (url && unread) {
				link.setAttribute('type', 'image/png');
				link.setAttribute('href', url);
			}
		});
	}
}

// Restore the tab to its resting state.
export function clearUnread(): void {
	if (!unread) return;
	unread = false;
	if (originalTitle !== null) document.title = originalTitle;
	if (iconLink) {
		if (originalIconHref !== null) iconLink.setAttribute('href', originalIconHref);
		if (originalIconType !== null) iconLink.setAttribute('type', originalIconType);
		else iconLink.removeAttribute('type');
	}
}

// Surface an inbound message that arrived while the user isn't looking: dot the
// tab and fire a content-free notification. No-op on native (APNs handles it) and
// when the tab is focused (the message is already visible in-app). This is the
// one entry point the chat view calls per new inbound message.
export function surfaceInboundActivity(): void {
	if (isNativePlatform() || document.hasFocus()) return;
	flagUnread();
	notifyActivity();
}

// Content-free browser notification. Only fires when the user has ALREADY granted
// the notification permission (via enabling Web Push) — this never prompts.
//
// Deliberately CALM: a fixed tag and no `renotify` mean the first message while
// away alerts, and later ones silently update the same banner rather than
// re-pinging for each arrival. The persistent tab dot is the ongoing "you have
// unread" signal; this is just the initial heads-up. (Switch to `renotify: true`
// if per-message re-alerting is wanted.) The tag also collapses a reconnect
// resync burst into one banner.
export function notifyActivity(): void {
	try {
		if (!('Notification' in window) || Notification.permission !== 'granted') return;
		const n = new Notification(getDecoyLabel(), {
			tag: 'flatfold-activity',
			icon: '/apple-touch-icon.png',
			// No body, no sender — content-free by design.
		});
		n.onclick = () => {
			window.focus();
			n.close();
		};
	} catch {
		/* notifications unsupported or blocked — the tab dot still applies */
	}
}
