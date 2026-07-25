import { isNativePlatform } from './platform';

// A single, feature-detected haptic tick. Used on send, long-press, verify, and
// tab switches — deliberately NOT on message receive (unsolicited buzzing is
// hostile, and a buzz on inbound could leak "a message arrived" to someone
// watching the phone).
//
// Native (iOS/Android): the Taptic Engine via @capacitor/haptics — iOS WKWebView
// does NOT support `navigator.vibrate`, so without this every native haptic was a
// silent no-op. Web: `navigator.vibrate` where available (Android Chrome), a safe
// no-op on iOS Safari / desktop. The native plugin is imported lazily so it never
// enters the web bundle.
export function haptic(durationMs = 10): void {
	if (isNativePlatform()) {
		void (async () => {
			try {
				const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
				await Haptics.impact({ style: ImpactStyle.Light });
			} catch {
				// Plugin unavailable — silent.
			}
		})();
		return;
	}
	try {
		if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
			navigator.vibrate(durationMs);
		}
	} catch {
		// Some embedded webviews expose `vibrate` but throw on call — ignore.
	}
}
