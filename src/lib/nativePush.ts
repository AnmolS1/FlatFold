// Native (iOS APNs) push registration — the counterpart to the Web Push flow in
// push.ts. WKWebView has no Service Worker, so native can't use Web Push; it
// registers with APNs via @capacitor/push-notifications and hands the device
// token to the server (worker/push.ts sends the content-free wake-up to it).
//
// The payload stays content-free end to end: the server only ever sends
// {"aps":{"content-available":1}}, and the app's push handler shows the decoy
// label — nothing identifying, same privacy posture as Web Push.
import { PushNotifications } from '@capacitor/push-notifications';
import { LocalNotifications } from '@capacitor/local-notifications';
import { apiSubscribeApns, apiUnsubscribeApns } from './api';
import { getDecoyLabel, type SubscribeResult } from './push';

let displayHandlerRegistered = false;

// Turn a content-free APNs wake-up into a VISIBLE but non-identifying banner: a
// local notification titled with the user's decoy label. The server payload
// carries no text or sender ({"aps":{"content-available":1}}); the decoy label
// lives only on this device. Best-effort by nature — iOS throttles silent
// (content-available) pushes, so delivery isn't guaranteed when the app has been
// idle/force-quit; the reliable-delivery upgrade is a Notification Service
// Extension (documented as a follow-up). Registered once at app start.
export async function initNativePushDisplay(): Promise<void> {
	if (displayHandlerRegistered) return;
	displayHandlerRegistered = true;
	await PushNotifications.addListener('pushNotificationReceived', () => {
		void LocalNotifications.schedule({
			notifications: [
				{
					id: Date.now() % 2_000_000_000,
					title: getDecoyLabel(),
					body: '',
				},
			],
		});
	});
}

// register() is fire-and-forget; the APNs device token arrives on the
// 'registration' event. Wrap that into a promise (with a timeout + cleanup).
function registerForApnsToken(): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		const done = async (fn: () => void) => {
			if (settled) return;
			settled = true;
			await PushNotifications.removeAllListeners();
			fn();
		};
		const timer = setTimeout(() => void done(() => reject(new Error('APNs registration timed out'))), 15000);
		void PushNotifications.addListener('registration', (t) => {
			clearTimeout(timer);
			void done(() => resolve(t.value));
		});
		void PushNotifications.addListener('registrationError', (e) => {
			clearTimeout(timer);
			void done(() => reject(new Error(String(e?.error ?? 'APNs registration error'))));
		});
		void PushNotifications.register();
	});
}

export async function subscribeToApnsNative(): Promise<SubscribeResult> {
	try {
		const perm = await PushNotifications.requestPermissions();
		if (perm.receive !== 'granted') return 'denied';
		const deviceToken = await registerForApnsToken();
		// environment omitted → server defaults to 'production' (the TestFlight /
		// App Store aps-environment; the app ships with aps-environment=production).
		await apiSubscribeApns(deviceToken);
		return 'subscribed';
	} catch {
		return 'error';
	}
}

export async function unsubscribeApnsNative(): Promise<void> {
	try {
		const deviceToken = await registerForApnsToken().catch(() => null);
		if (deviceToken) await apiUnsubscribeApns(deviceToken).catch(() => {});
		// The server also prunes dead tokens on an APNs 410, so this is best-effort.
	} catch {
		/* ignore */
	}
}

export async function isApnsSubscribed(): Promise<boolean> {
	try {
		const perm = await PushNotifications.checkPermissions();
		return perm.receive === 'granted';
	} catch {
		return false;
	}
}
