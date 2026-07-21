// Web vs native (Capacitor) runtime detection + the origins each targets.
//
// Native clients load their app shell from capacitor://localhost (iOS) or
// https://localhost (Android) — a DIFFERENT origin from the API — so they must
// call the API by absolute URL and can't use the SameSite=Strict cookie. Web is
// same-origin and keeps relative URLs + the cookie.
//
// Detection reads the `window.Capacitor` bridge the native runtime injects; no
// @capacitor/core import, so the web bundle is unaffected. Evaluated at CALL
// time (not module load) because the bridge can attach slightly after first
// script execution — and so it's trivially testable.

interface CapacitorBridge {
	isNativePlatform?: () => boolean;
}

export function isNativePlatform(): boolean {
	if (typeof window === 'undefined') return false;
	const bridge = (window as unknown as { Capacitor?: CapacitorBridge }).Capacitor;
	return !!bridge?.isNativePlatform?.();
}

// The absolute API origin for native, empty (same-origin/relative) for web.
// VITE_API_ORIGIN lets a native preview build point at the preview worker.
export function apiOrigin(): string {
	if (!isNativePlatform()) return '';
	return (import.meta.env.VITE_API_ORIGIN as string | undefined) ?? 'https://flatfold.ponderance.dev';
}

// wss:// origin for the native WebSocket. Web derives its own from location.
export function wsOrigin(): string {
	return apiOrigin().replace(/^http/, 'ws');
}
