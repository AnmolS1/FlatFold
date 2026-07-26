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

// True when this is the iPad app running on a Mac ("Designed for iPad"), set
// natively from `ProcessInfo.isiOSAppOnMac` (MainViewController injects it at
// document start).
//
// Worth having as its own signal rather than inferring: iPadOS lies to the web
// layer there. It fires keyboardWillShow with a height for a keyboard it never
// draws, so anything that resizes to accommodate a keyboard must not. Guessing
// from `navigator.maxTouchPoints` was the first attempt and is a heuristic about
// touchscreens, which is a different question.
export function isIOSAppOnMac(): boolean {
	if (typeof window === 'undefined') return false;
	return (window as unknown as { __flatfoldIsIOSAppOnMac?: boolean }).__flatfoldIsIOSAppOnMac === true;
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
