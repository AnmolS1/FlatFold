// The single fetch chokepoint for /api/* calls, so the native (bearer) vs web
// (cookie) difference lives in ONE place instead of every call site.
//
// Web: relative URL + the SameSite=Strict cookie (credentials:'include').
// Native: absolute origin + `X-FlatFold-Native` (tells the server to return the
//   token in the body, not a cookie) + `Authorization: Bearer <token>`.
// credentials:'include' stays on both — harmless for native (no cookie to send).
import { apiOrigin, isNativePlatform } from './platform';
import { loadNativeToken } from './nativeToken';

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	const native = isNativePlatform();
	if (native) {
		headers.set('X-FlatFold-Native', '1');
		const token = await loadNativeToken();
		if (token) headers.set('Authorization', `Bearer ${token}`);
	}
	// web: send the SameSite=Strict cookie (same-origin). native: OMIT — it's
	// bearer auth, and a credentialed cross-origin request would be blocked by our
	// deliberate `Access-Control-Allow-Origin: *` with no Allow-Credentials.
	return fetch(`${apiOrigin()}${path}`, { ...init, credentials: native ? 'omit' : 'include', headers });
}
