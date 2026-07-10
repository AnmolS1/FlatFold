// Sealed-sender OHTTP gateway (RFC 9458 / 9180 HPKE). A sealed send arrives
// here HPKE-encapsulated, having transited a third-party relay that stripped
// the client IP — so this Worker (the "gateway") sees the request CONTENT but
// never the sender's IP, and the request carries no sender identity at all.
// The gateway decapsulates, then routes {recipient, token, envelope} to the
// recipient's mailbox DO for token-validated delivery. The server thus learns
// "a valid-token message arrived for R" — never who sent it.
//
// Responses are deliberately opaque (always 202): the endpoint is unauthenticated
// and must not be an oracle for valid recipients/tokens. Sender-visible delivery
// confirmation comes from the sealed delivered-receipt, not this HTTP status.

import { Aes128Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import { lookupBundleForSeal } from './keys';
import { checkRateLimit } from './db';
import { sealResponse, SEALED_RESPONSE_EXPORT_LABEL, SEALED_RESPONSE_EXPORT_LENGTH } from '../shared/sealedResponse';

const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
const ENC_LEN = 65; // DHKEM(P-256,HKDF-SHA256) encapsulated key = uncompressed point
const EXPORT_LABEL = new TextEncoder().encode(SEALED_RESPONSE_EXPORT_LABEL);
const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Blunt GLOBAL throttle on the anonymous bundle-fetch oracle. This path has no
// authenticated requester to key a per-actor limit on (that's the point), and
// per-target keying does nothing against enumeration (it spreads across names) —
// so a single global fixed-window bucket is the honest shape. It's defense-in-
// depth *before* an OHTTP relay fronts the gateway; a real deployment's throttle
// belongs at the relay. Tradeoff (documented in THREAT_MODEL): being global, a
// flood can throttle legitimate first-contacts app-wide, and the cap is coarse.
// Tune here. Reuses the same atomic fixed-window limiter as bundle lookups, with
// a constant key so all anonymous fetches share one bucket.
const ANON_FETCH_BUCKET_KEY = 'seal:fetchbundle';
const ANON_FETCH_WINDOW_SECONDS = 60;
const ANON_FETCH_GLOBAL_LIMIT = 120;

// Published so clients can encapsulate to this gateway. Non-secret.
export function handleSealKeys(env: Env): Response {
	return new Response(
		JSON.stringify({
			kem: 'DHKEM(P-256,HKDF-SHA256)',
			kdf: 'HKDF-SHA256',
			aead: 'AES-128-GCM',
			encLength: ENC_LEN,
			publicKey: env.SEAL_GATEWAY_PUBLIC_KEY,
		}),
		{ headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } }
	);
}

interface SealedInner {
	// Operation discriminator. Absent / 'send' = deliver a sealed message (the
	// increment-1 path). 'fetchBundle' = anonymously fetch a peer's prekey bundle
	// (increment 3) — the response is sealed back over the same HPKE context.
	op?: unknown;
	recipient?: unknown;
	token?: unknown;
	envelope?: unknown;
	contact?: unknown; // fetchBundle: whose bundle to return
}

// Independent OHTTP relays (oblivious.network) forward the gateway RESPONSE only
// when it is labelled message/ohttp-res (RFC 9458 §4.4); a bare 202 has its body
// DROPPED relay-side (verified empirically — the sealed fetchBundle body came back
// empty until this header was set). So every gateway response on this path carries
// it. Content is unchanged; the label is what the relay gates the body on.
const OHTTP_RES = { 'Content-Type': 'message/ohttp-res' } as const;
const ACCEPTED = new Response(null, { status: 202, headers: OHTTP_RES }); // uniform, non-oracle
const utf8 = new TextEncoder();

// Constant-time byte compare. No early return; a length mismatch is folded into
// the accumulator so timing doesn't leak the compared length either. (The secret
// is a fixed-length token, so length isn't sensitive — this is defense in depth.)
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	const len = Math.max(a.length, b.length);
	let diff = a.length ^ b.length;
	for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return diff === 0;
}

// Relay-auth gate for POST /api/seal. The independent OHTTP relay injects a
// shared secret as `X-Seal-Relay-Auth` (configured relay-side); we require it so
// the gateway only accepts sealed sends that actually transited the relay — never
// a client reaching the gateway directly with its own IP. SEAL_RELAY_AUTH holds a
// comma-separated allow-list (two valid secrets during rotation, and the Tier-1
// Fastly fallback shares one). If the secret is UNSET/empty the gate is OFF: that
// is local dev (same-origin, no relay), which must keep working. Iterates the
// whole list with no short-circuit so it's not a timing oracle for which entry
// matched. The header (and body) are never logged.
function relayAuthAccepted(provided: string | null, configured: string | undefined): boolean {
	const list = (configured ?? '').split(',').map((s) => s.trim()).filter(Boolean);
	if (list.length === 0) return true; // unset ⇒ enforcement off (dev)
	if (provided === null) return false;
	const p = utf8.encode(provided);
	let matched = 0;
	for (const secret of list) matched |= timingSafeEqual(p, utf8.encode(secret)) ? 1 : 0;
	return matched === 1;
}

export async function handleSeal(request: Request, env: Env): Promise<Response> {
	// Enforce the relay-auth header BEFORE reading the body or touching HPKE, so an
	// unauthenticated caller can't even probe the decapsulation path. 403 here is
	// deliberate (distinct from the uniform 202 below): it only reveals "you didn't
	// come via the relay", not anything about recipients or tokens.
	if (!relayAuthAccepted(request.headers.get('X-Seal-Relay-Auth'), env.SEAL_RELAY_AUTH)) {
		return new Response(null, { status: 403 });
	}

	let inner: SealedInner;
	let encBytes: Uint8Array;
	let ctx: Awaited<ReturnType<typeof suite.createRecipientContext>>;
	try {
		const body = new Uint8Array(await request.arrayBuffer());
		if (body.length <= ENC_LEN) return ACCEPTED.clone();
		encBytes = body.slice(0, ENC_LEN);
		const ciphertext = body.slice(ENC_LEN).buffer;
		const recipientKey = await suite.kem.deserializePrivateKey(b64ToBytes(env.SEAL_GATEWAY_PRIVATE_KEY).buffer);
		ctx = await suite.createRecipientContext({ recipientKey, enc: encBytes.buffer });
		const plaintext = new Uint8Array(await ctx.open(ciphertext));
		inner = JSON.parse(new TextDecoder().decode(plaintext)) as SealedInner;
	} catch {
		// Decapsulation/parse failure — accept-and-drop, never leak the reason.
		return ACCEPTED.clone();
	}

	// Anonymous bundle fetch (increment 3). The response is sealed back to the
	// client with an AEAD keyed off the HPKE exporter secret (@hpke/core can't
	// seal on the recipient context — see shared/sealedResponse.ts). A missing
	// user yields a length-uniform sealed "not found" sentinel, never a
	// distinguishable status — so a relay can't read target-existence off the
	// response. The gateway learns the lookup TARGET but never who asked.
	if (inner.op === 'fetchBundle') {
		if (typeof inner.contact !== 'string') return ACCEPTED.clone();
		// Global anti-enumeration throttle. Over the cap → uniform empty 202 (the
		// same non-body response as a send / a malformed request), so it's not a
		// per-target oracle — the limit is global, independent of the lookup
		// target, so it never leaks whether `contact` exists. A throttled client
		// sees no sealed body and treats it as a transient error.
		const windowStart = Math.floor(Date.now() / 1000 / ANON_FETCH_WINDOW_SECONDS) * ANON_FETCH_WINDOW_SECONDS;
		if (!(await checkRateLimit(env.DB, ANON_FETCH_BUCKET_KEY, windowStart, ANON_FETCH_GLOBAL_LIMIT))) {
			return ACCEPTED.clone();
		}
		try {
			const secret = new Uint8Array(await ctx.export(EXPORT_LABEL, SEALED_RESPONSE_EXPORT_LENGTH));
			const bundle = await lookupBundleForSeal(env, inner.contact);
			const plaintext = new TextEncoder().encode(JSON.stringify(bundle ?? { notFound: true }));
			const sealed = await sealResponse(secret, encBytes, plaintext);
			return new Response(sealed, { status: 202, headers: OHTTP_RES });
		} catch {
			return ACCEPTED.clone(); // never leak why
		}
	}

	// Sealed message delivery (increment 1). Route to the recipient's DO for
	// token validation + delivery — the only place the recipient username is
	// used, and the sender is never known.
	if (typeof inner.recipient !== 'string' || typeof inner.token !== 'string' || !inner.envelope) {
		return ACCEPTED.clone();
	}
	try {
		await env.MAILBOX.getByName(inner.recipient).fetch('https://internal/sealed-deliver', {
			method: 'POST',
			body: JSON.stringify({ token: inner.token, envelope: inner.envelope, recipient: inner.recipient }),
		});
	} catch {
		/* swallow — uniform response regardless */
	}
	return ACCEPTED.clone();
}
