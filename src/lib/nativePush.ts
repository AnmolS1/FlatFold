// Native (iOS APNs) push registration — the counterpart to the Web Push flow in
// push.ts. WKWebView has no Service Worker, so native can't use Web Push; it
// registers with APNs via @capacitor/push-notifications and hands the device
// token to the server (worker/push.ts sends the content-free wake-up to it).
//
// The payload stays content-free end to end: the server only ever sends
// {"aps":{"content-available":1}}, and the app's push handler shows the decoy
// label — nothing identifying, same privacy posture as Web Push.
//
// "Subscribed" is tracked as a LOCAL PREFERENCE FLAG, not as the OS permission:
// iOS permission is sticky and can't be revoked in-app, so a permission-derived
// toggle can neither turn off nor notice that the *server* lost the subscription
// (e.g. after switching backends). The flag is the user's intent; reconcile()
// re-registers the token with the CURRENT server whenever the flag is set.
import { PushNotifications } from '@capacitor/push-notifications';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { PluginListenerHandle } from '@capacitor/core';
import { apiSubscribeApns, apiUnsubscribeApns } from './api';
import { getDecoyLabel, type SubscribeResult } from './push';

const ENABLED_KEY = 'flatfold-push-enabled';

function setEnabledFlag(on: boolean): void {
	try {
		if (on) localStorage.setItem(ENABLED_KEY, '1');
		else localStorage.removeItem(ENABLED_KEY);
	} catch {
		/* storage unavailable */
	}
}
function enabledFlag(): boolean {
	try {
		return localStorage.getItem(ENABLED_KEY) === '1';
	} catch {
		return false;
	}
}

// register() is fire-and-forget; the APNs device token arrives on the
// 'registration' event. Wrap that into a promise, removing ONLY our own two
// listeners (not the app-wide pushNotificationReceived display handler).
async function registerForApnsToken(): Promise<string> {
	const handles: PluginListenerHandle[] = [];
	try {
		return await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('APNs registration timed out')), 15000);
			void Promise.all([
				PushNotifications.addListener('registration', (t) => {
					clearTimeout(timer);
					resolve(t.value);
				}),
				PushNotifications.addListener('registrationError', (e) => {
					clearTimeout(timer);
					reject(new Error(String(e?.error ?? 'APNs registration error')));
				}),
			]).then((hs) => {
				handles.push(...hs);
				void PushNotifications.register();
			});
		});
	} finally {
		await Promise.all(handles.map((h) => h.remove()));
	}
}

export async function subscribeToApnsNative(): Promise<SubscribeResult> {
	try {
		const perm = await PushNotifications.requestPermissions();
		if (perm.receive !== 'granted') return 'denied';
		const deviceToken = await registerForApnsToken();
		// environment omitted → server defaults to 'production' and falls back to
		// sandbox if the token is a dev-build token (worker/push.ts).
		await apiSubscribeApns(deviceToken);
		setEnabledFlag(true);
		return 'subscribed';
	} catch {
		return 'error';
	}
}

export async function unsubscribeApnsNative(): Promise<void> {
	setEnabledFlag(false);
	try {
		const deviceToken = await registerForApnsToken().catch(() => null);
		if (deviceToken) await apiUnsubscribeApns(deviceToken).catch(() => {});
		// The server also prunes dead tokens on an APNs 410, so this is best-effort.
	} catch {
		/* ignore */
	}
}

// Reflects the user's stored PREFERENCE (see the module note), not the OS grant.
export async function isApnsSubscribed(): Promise<boolean> {
	return enabledFlag();
}

// If the user wants push, make sure the CURRENT server holds the token — this is
// what re-registers after a backend switch (preview → prod) without a manual
// off/on. Best-effort; called once at app start.
export async function reconcileApnsSubscription(): Promise<void> {
	if (!enabledFlag()) return;
	try {
		const perm = await PushNotifications.checkPermissions();
		if (perm.receive !== 'granted') return;
		const deviceToken = await registerForApnsToken();
		await apiSubscribeApns(deviceToken);
	} catch {
		/* best-effort */
	}
}

let displayHandlerRegistered = false;

// Turn a content-free APNs wake-up into a VISIBLE but non-identifying banner: a
// local notification titled with the user's decoy label (never text/sender).
// Best-effort — iOS throttles silent (content-available) pushes. Registered once.
export async function initNativePushDisplay(): Promise<void> {
	if (displayHandlerRegistered) return;
	displayHandlerRegistered = true;
	await PushNotifications.addListener('pushNotificationReceived', () => {
		void LocalNotifications.schedule({
			notifications: [{ id: Date.now() % 2_000_000_000, title: getDecoyLabel(), body: '' }],
		});
	});
}
