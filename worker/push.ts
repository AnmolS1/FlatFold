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

// ---- APNs (native iOS) ----
//
// Native clients run in a WKWebView, which has NO Service Worker, so Web Push
// is unavailable to them. They register an APNs device token instead and we
// wake them with a SILENT background push. The invariant is identical: the
// push is content-free — its ONLY payload is `{"aps":{"content-available":1}}`,
// carrying no message text and no sender. See test/push.test.ts.
//
// Provider auth is a token-based ES256 JWT (Apple's ".p8" key), NOT a per-app
// certificate. The private key lives in env.APNS_KEY (a secret); the key id,
// team id, and bundle id are non-secret vars.

export type ApnsEnvironment = 'production' | 'sandbox';

const APNS_HOSTS: Record<ApnsEnvironment, string> = {
	production: 'api.push.apple.com',
	sandbox: 'api.sandbox.push.apple.com',
};

// APNs device tokens are hex strings. Validating on BOTH the inbound subscribe
// path and before building the outbound URL prevents a crafted token from
// injecting path segments into `…/3/device/<token>` (defense in depth).
export function isValidDeviceToken(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-fA-F]{64,200}$/.test(value);
}

// Decodes a PEM-wrapped PKCS8 private key (the .p8 file contents) to raw DER
// bytes for crypto.subtle.importKey('pkcs8', …). Apple's .p8 is already PKCS8
// (`-----BEGIN PRIVATE KEY-----`), so no SEC1→PKCS8 conversion is needed.
function pemToDerBytes(pem: string): Uint8Array {
	const b64 = pem
		.replace(/-----BEGIN [^-]+-----/g, '')
		.replace(/-----END [^-]+-----/g, '')
		.replace(/\s+/g, '');
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// Signs an APNs provider-authentication JWT (ES256). WebCrypto's ECDSA sign
// already returns the raw r||s (JOSE) signature APNs wants — no DER unwrap,
// mirroring signVapidJwt above. v1 signs per send; the token may be reused for
// ~40 min, a later optimization.
async function signApnsProviderToken(env: Env, environment: ApnsEnvironment): Promise<string> {
	// These APNs keys are provisioned per-environment (prod: APNS_KEY_ID; sandbox:
	// APNS_KEY_ID_SANDBOX). A DEBUG/dev build produces a sandbox device token, and
	// signing with the prod key against the sandbox host returns
	// BadEnvironmentKeyInToken — so use the sandbox key there when it's configured
	// (release/TestFlight builds use the prod key + host and never hit this).
	const useSandbox = environment === 'sandbox' && !!env.APNS_KEY_SANDBOX && !!env.APNS_KEY_ID_SANDBOX;
	const pem = useSandbox ? env.APNS_KEY_SANDBOX! : env.APNS_KEY;
	const kid = useSandbox ? env.APNS_KEY_ID_SANDBOX! : env.APNS_KEY_ID;
	const key = await crypto.subtle.importKey('pkcs8', pemToDerBytes(pem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
	const header = { alg: 'ES256', kid };
	const claims = { iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) };
	const signingInput = `${jsonToB64url(header)}.${jsonToB64url(claims)}`;
	const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
	return `${signingInput}.${bytesToB64url(new Uint8Array(signature))}`;
}

// Builds the content-free APNs wake-up request for one device token. Exported
// so a test can assert the body carries ONLY the silent-push signal and no
// message content or sender. The device token is the recipient's device, not
// content — it necessarily rides in the URL path per Apple's protocol.
// The fixed, generic title shown on a native push. Matches the web default decoy
// label; deliberately says nothing about FlatFold, the sender, or the message.
const DECOY_PUSH_TITLE = 'New activity';

export async function buildApnsRequest(env: Env, deviceToken: string, environment: ApnsEnvironment): Promise<Request> {
	const host = APNS_HOSTS[environment] ?? APNS_HOSTS.production;
	const jwt = await signApnsProviderToken(env, environment);
	return new Request(`https://${host}/3/device/${deviceToken}`, {
		method: 'POST',
		// APNs never redirects, but keep the SSRF-safe default of never following
		// one — consistent with the Web Push path.
		redirect: 'manual',
		headers: {
			authorization: `bearer ${jwt}`,
			'apns-topic': env.APNS_BUNDLE_ID,
			// An ALERT push (not a silent content-available one): iOS displays it
			// directly, so it doesn't depend on the OS choosing to wake a suspended
			// app — the reliable way to surface a native banner. A silent push does
			// NOT trigger Capacitor's pushNotificationReceived in the background, so
			// the app can't schedule anything to show.
			'apns-push-type': 'alert',
			'apns-priority': '10',
		},
		// CONTENT-FREE still holds: the ONLY visible text is a fixed, generic decoy
		// title — no message text, no sender, nothing identifying. (The per-user
		// custom decoy label lives client-side; wiring it server-side for native is
		// a follow-up — see THREAT_MODEL #22.)
		body: JSON.stringify({ aps: { alert: { title: DECOY_PUSH_TITLE }, sound: 'default' } }),
	});
}

// Sends a content-free wake-up to every device `username` has subscribed —
// across BOTH transports. Best-effort: a dead subscription is pruned.
export async function sendWakeupToUser(env: Env, username: string): Promise<void> {
	// Web Push (browsers). Preserved unchanged. A 404/410 means it's gone.
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

	// APNs (native iOS). The parallel sender for the other transport. A 410
	// from APNs means the token is no longer valid ("Unregistered"), so prune.
	const apnsRows = await env.DB.prepare('SELECT device_token, environment FROM apns_subscriptions WHERE username = ?')
		.bind(username)
		.all<{ device_token: string; environment: string }>();

	for (const { device_token, environment } of apnsRows.results ?? []) {
		// Defense in depth: never build a device URL from an unvalidated token.
		if (!isValidDeviceToken(device_token)) {
			await env.DB.prepare('DELETE FROM apns_subscriptions WHERE device_token = ?').bind(device_token).run();
			continue;
		}
		const stored: ApnsEnvironment = environment === 'sandbox' ? 'sandbox' : 'production';
		// Try the stored environment, then the OTHER one. A debug build installed via
		// Xcode/devicectl gets a SANDBOX token even though the entitlement says
		// production, so a production send 400s (BadDeviceToken) and used to fail
		// silently. Fall back instead, and remember which environment actually
		// worked so later sends hit it first. 410 (Unregistered) means the token is
		// dead → prune. A token that's bad in both environments just isn't delivered.
		const candidates: ApnsEnvironment[] = stored === 'sandbox' ? ['sandbox', 'production'] : ['production', 'sandbox'];
		for (const apnsEnv of candidates) {
			try {
				const response = await fetch(await buildApnsRequest(env, device_token, apnsEnv));
				if (response.status === 200) {
					if (apnsEnv !== stored) {
						await env.DB.prepare('UPDATE apns_subscriptions SET environment = ? WHERE device_token = ?')
							.bind(apnsEnv, device_token)
							.run();
					}
					break;
				}
				if (response.status === 410) {
					await env.DB.prepare('DELETE FROM apns_subscriptions WHERE device_token = ?').bind(device_token).run();
					break;
				}
				// Otherwise (e.g. 400 wrong-environment) fall through to the next candidate.
			} catch {
				// APNs unreachable (or local dev) — ignore; the client re-syncs on reconnect.
				break;
			}
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

// ---- APNs subscribe / unsubscribe (native iOS) ----

// The native client posts { deviceToken, environment? }. We store ONLY the
// token and its APNs environment — there is no payload and no encryption keys.
export async function handleApnsSubscribe(request: Request, env: Env, username: string): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { deviceToken?: unknown; environment?: unknown } | null;
	const deviceToken = body?.deviceToken;
	if (!isValidDeviceToken(deviceToken)) {
		return json({ error: 'Invalid device token.' }, { status: 400 });
	}
	const environment = body?.environment ?? 'production';
	if (environment !== 'production' && environment !== 'sandbox') {
		return json({ error: 'Invalid environment.' }, { status: 400 });
	}
	// On a conflict, only the CURRENT owner may refresh the row — a different
	// user cannot reassign someone else's device token to themselves (the WHERE
	// makes it a no-op). Ownership is never silently transferred.
	await env.DB.prepare(
		`INSERT INTO apns_subscriptions (username, device_token, environment, created_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(device_token) DO UPDATE SET environment = excluded.environment, created_at = excluded.created_at
		 WHERE username = excluded.username`
	)
		.bind(username, deviceToken, environment, Math.floor(Date.now() / 1000))
		.run();
	return json({ ok: true });
}

export async function handleApnsUnsubscribe(request: Request, env: Env, username: string): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { deviceToken?: unknown } | null;
	const deviceToken = body?.deviceToken;
	if (typeof deviceToken !== 'string') return json({ error: 'Missing device token.' }, { status: 400 });
	await env.DB.prepare('DELETE FROM apns_subscriptions WHERE device_token = ? AND username = ?').bind(deviceToken, username).run();
	return json({ ok: true });
}
