// Web Push — content-free "wake up and sync" only.
//
// The push message carries NO payload: no message text, no sender, nothing.
// It is a bare, VAPID-authenticated POST to the subscription endpoint with an
// empty body. The client's service worker, on receiving it, shows a generic
// notification titled with the user's own local decoy label, then the app
// fetches and decrypts on its own. This is invariant #1 (plaintext never
// leaves the device) and #5 (metadata minimization) by construction — there
// is nothing in the push to leak.
//
// VAPID signing is ES256 (ECDSA P-256) via WebCrypto — NOT the `web-push` npm
// library, which uses Node's `crypto`/`https` and won't run on workerd.
//
// Actual delivery requires a real push service and a live browser
// subscription, so it is deploy-only; locally these functions run but the
// POST to the (fake) endpoint no-ops. What IS verifiable locally and is the
// security-critical property — that the request carries no content — is
// asserted in test/push.test.ts against `buildWakeupRequest`.

// The push endpoint is client-supplied and the worker fetches it, so an
// unvalidated endpoint is an SSRF vector (point it at an internal service).
// Restrict to the known public push-service hosts, checked on BOTH the
// inbound subscribe path and the outbound send path (defense in depth).
const PUSH_HOSTS = [
	'fcm.googleapis.com',
	'android.googleapis.com', // legacy GCM
	'updates.push.services.mozilla.com',
	'push.apple.com', // web.push.apple.com and *.push.apple.com
	'notify.windows.com', // *.notify.windows.com (WNS)
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return false;
	}
	if (url.protocol !== 'https:') return false;
	return PUSH_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

function bytesToB64url(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function jsonToB64url(value: unknown): string {
	return bytesToB64url(new TextEncoder().encode(JSON.stringify(value)));
}

interface VapidJwk {
	kty: 'EC';
	crv: 'P-256';
	d: string;
	x: string;
	y: string;
}

// Signs a VAPID JWT (ES256) scoped to a push service's origin. Reads the
// private key from env.VAPID_PRIVATE_JWK (a JWK JSON string — a placeholder
// locally, a `wrangler secret put` value in production).
async function signVapidJwt(env: Env, audience: string): Promise<string> {
	const jwk = JSON.parse(env.VAPID_PRIVATE_JWK) as VapidJwk;
	const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

	const nowSeconds = Math.floor(Date.now() / 1000);
	const header = { typ: 'JWT', alg: 'ES256' };
	const payload = { aud: audience, exp: nowSeconds + 12 * 60 * 60, sub: env.VAPID_SUBJECT };
	const signingInput = `${jsonToB64url(header)}.${jsonToB64url(payload)}`;

	const signature = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		key,
		new TextEncoder().encode(signingInput)
	);
	return `${signingInput}.${bytesToB64url(new Uint8Array(signature))}`;
}

// Builds the content-free wake-up request for one subscription endpoint.
// Exported so a test can assert it carries no message content. There is no
// body at all — a payload-less Web Push.
export async function buildWakeupRequest(env: Env, endpoint: string): Promise<Request> {
	const audience = new URL(endpoint).origin;
	const jwt = await signVapidJwt(env, audience);
	return new Request(endpoint, {
		method: 'POST',
		// A 3xx must not be able to re-introduce SSRF by redirecting to an
		// internal target — never follow redirects on this fetch.
		redirect: 'manual',
		headers: {
			Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
			TTL: '2419200', // 4 weeks; the push service may drop it sooner
			// No Content-Encoding / body: this is a data-less push.
		},
	});
}

// Sends a content-free wake-up to every device `username` has subscribed.
// Best-effort: a 404/410 means the subscription is gone, so we prune it.
export async function sendWakeupToUser(env: Env, username: string): Promise<void> {
	const rows = await env.DB.prepare('SELECT endpoint FROM push_subscriptions WHERE username = ?')
		.bind(username)
		.all<{ endpoint: string }>();

	for (const { endpoint } of rows.results ?? []) {
		// Re-validate on the outbound path — a row could predate a tightened
		// allowlist, and we never want the worker fetching an arbitrary host.
		if (!isAllowedPushEndpoint(endpoint)) {
			await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
			continue;
		}
		try {
			const response = await fetch(await buildWakeupRequest(env, endpoint));
			if (response.status === 404 || response.status === 410) {
				await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
			}
		} catch {
			// Push service unreachable (or a fake local endpoint) — ignore; the
			// client re-syncs on reconnect regardless.
		}
	}
}

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
}

// The client posts only { endpoint } — we deliberately do not accept or store
// the p256dh/auth payload-encryption keys (there is no payload).
export async function handlePushSubscribe(request: Request, env: Env, username: string): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
	const endpoint = body?.endpoint;
	if (typeof endpoint !== 'string' || !isAllowedPushEndpoint(endpoint)) {
		return json({ error: 'Invalid subscription endpoint.' }, { status: 400 });
	}
	// On a conflict, only the CURRENT owner may refresh the row — a different
	// user cannot reassign someone else's subscription to themselves (the
	// WHERE makes it a no-op). Endpoints are unguessable, but ownership is
	// never silently transferred regardless.
	await env.DB.prepare(
		`INSERT INTO push_subscriptions (username, endpoint, created_at) VALUES (?, ?, ?)
		 ON CONFLICT(endpoint) DO UPDATE SET created_at = excluded.created_at WHERE username = excluded.username`
	)
		.bind(username, endpoint, Math.floor(Date.now() / 1000))
		.run();
	return json({ ok: true });
}

export async function handlePushUnsubscribe(request: Request, env: Env, username: string): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
	const endpoint = body?.endpoint;
	if (typeof endpoint !== 'string') return json({ error: 'Missing endpoint.' }, { status: 400 });
	await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND username = ?').bind(endpoint, username).run();
	return json({ ok: true });
}

// Exposes the VAPID public key so the client can subscribe.
export function handleVapidPublicKey(env: Env): Response {
	return json({ publicKey: env.VAPID_PUBLIC_KEY });
}
