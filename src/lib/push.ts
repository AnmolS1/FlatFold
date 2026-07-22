// Client-side Web Push: subscribe/unsubscribe, and the decoy notification
// label. FlatFold's push is payload-less — the server only ever sends a
// content-free "wake up and sync" signal — so nothing sensitive is involved
// here beyond the (opaque) subscription endpoint.

import { isNativePlatform } from './platform';
import { isApnsSubscribed, subscribeToApnsNative, unsubscribeApnsNative } from './nativePush';

const PREFS_CACHE = 'flatfold-prefs';
const DECOY_KEY = '/__decoy_label';

export function isPushSupported(): boolean {
	// Native iOS supports push via APNs (no Service Worker / Web Push needed).
	if (isNativePlatform()) return true;
	return (
		typeof navigator !== 'undefined' &&
		'serviceWorker' in navigator &&
		typeof window !== 'undefined' &&
		'PushManager' in window &&
		'Notification' in window
	);
}

// The VAPID public key (base64url) must be an ArrayBuffer-backed view for
// pushManager.subscribe.
function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
	const binary = atob(padded);
	const buffer = new ArrayBuffer(binary.length);
	const bytes = new Uint8Array(buffer);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export type SubscribeResult = 'subscribed' | 'denied' | 'unsupported' | 'error';

export async function subscribeToPush(): Promise<SubscribeResult> {
	if (isNativePlatform()) return subscribeToApnsNative(); // iOS APNs, not Web Push
	if (!isPushSupported()) return 'unsupported';
	try {
		const permission = await Notification.requestPermission();
		if (permission !== 'granted') return 'denied';

		const registration = await navigator.serviceWorker.ready;
		const { publicKey } = (await (await fetch('/api/push/vapid-public-key')).json()) as { publicKey: string };
		const subscription = await registration.pushManager.subscribe({
			userVisibleOnly: true, // required; we always show the decoy notification
			applicationServerKey: base64urlToBytes(publicKey),
		});
		await fetch('/api/push/subscribe', {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ endpoint: subscription.endpoint }),
		});
		return 'subscribed';
	} catch {
		return 'error';
	}
}

export async function unsubscribeFromPush(): Promise<void> {
	if (isNativePlatform()) return unsubscribeApnsNative();
	if (!isPushSupported()) return;
	const registration = await navigator.serviceWorker.getRegistration();
	const subscription = await registration?.pushManager.getSubscription();
	if (!subscription) return;
	await fetch('/api/push/unsubscribe', {
		method: 'POST',
		credentials: 'include',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ endpoint: subscription.endpoint }),
	}).catch(() => {});
	await subscription.unsubscribe().catch(() => {});
}

export async function isSubscribedToPush(): Promise<boolean> {
	if (isNativePlatform()) return isApnsSubscribed();
	if (!isPushSupported()) return false;
	const registration = await navigator.serviceWorker.getRegistration();
	const subscription = await registration?.pushManager.getSubscription();
	return !!subscription;
}

// ---- decoy notification label ----
// Stored in a cache the service worker's push handler reads, so a wake-up
// notification shows this innocuous label ("Calendar", "News update", …)
// instead of anything identifying FlatFold — shoulder-surfing protection.

export const DEFAULT_DECOY_LABEL = 'New activity';

export async function setDecoyLabel(label: string): Promise<void> {
	if (typeof caches === 'undefined') return;
	const cache = await caches.open(PREFS_CACHE);
	await cache.put(DECOY_KEY, new Response(label || DEFAULT_DECOY_LABEL, { headers: { 'Content-Type': 'text/plain' } }));
	// Also mirror to localStorage so the settings UI can show the current value
	// without reading the cache.
	try {
		localStorage.setItem('flatfold-decoy-label', label);
	} catch {
		/* ignore */
	}
}

export function getDecoyLabel(): string {
	try {
		return localStorage.getItem('flatfold-decoy-label') || DEFAULT_DECOY_LABEL;
	} catch {
		return DEFAULT_DECOY_LABEL;
	}
}
