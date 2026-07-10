// Anonymous prekey-bundle fetch over the OHTTP gateway (sealed-sender increment
// 3). Lets a first-contact initiator fetch a peer's bundle (+ delivery token)
// WITHOUT the server learning who is asking: the request is HPKE-encapsulated to
// the gateway's published key and posted with NO session cookie, and the bundle
// comes back sealed under the HPKE exporter secret (shared/sealedResponse.ts,
// since @hpke/core can't seal on a context). The gateway learns the lookup
// target but not the initiator; real IP-blinding additionally needs the
// third-party relay (deferred). This is the MECHANISM — it is not yet wired into
// ensureSession; that (and sealing the first send) lands in increment 4.

import { Aes128Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import { base64ToBytes } from '../keystore/codec';
import { openResponse, SEALED_RESPONSE_EXPORT_LABEL, SEALED_RESPONSE_EXPORT_LENGTH } from '../../shared/sealedResponse';
import type { PreKeyBundleResponse, WsDeliveredFrame, WsMessageFrame } from '../types';

const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
const EXPORT_LABEL = new TextEncoder().encode(SEALED_RESPONSE_EXPORT_LABEL);
const utf8 = new TextEncoder();

const viteEnv = (typeof import.meta !== 'undefined' && (import.meta as { env?: Record<string, string | undefined> }).env) || {};

// The independent OHTTP relay URL (Tier-2 oblivious.network — see
// docs/RELAY_ONBOARDING.md). A FULL URL with a per-relay path (not just an origin)
// because oblivious.network relays carry a path. When set at build time, the
// encapsulated sealed requests POST to the relay, which blind-forwards to the
// gateway: the relay sees the client IP but not content; the gateway sees content
// but (behind the relay) not the IP, and only accepts the request because the
// relay injected the shared `X-Seal-Relay-Auth` header. Empty (dev / not-yet-
// relayed) = same-origin, i.e. straight to the gateway with NO IP-blinding.
const RELAY_URL: string = viteEnv.VITE_SEAL_RELAY_URL || '';
const SEAL_ENDPOINT = RELAY_URL || '/api/seal';

// Tier-1 Fastly VCL relay (FlatFold-operated) kept as a documented fallback: if
// the primary relay is unreachable (network/CORS) or returns a non-2xx, we retry
// once here. It's a different platform (blinds the IP from Cloudflare) but the
// same operator, so it's the weaker single-platform guarantee — good enough as a
// resilience fallback, not the headline property. Also a full URL. Empty ⇒ no
// fallback (the drill build sets no fallback so a CORS failure surfaces hard
// instead of being silently masked by Fastly).
const RELAY_FALLBACK_URL: string = viteEnv.VITE_SEAL_RELAY_FALLBACK_URL || '';

// Pinned SHA-256 (base64) of the gateway's published `publicKey`. Defends the
// key-consistency attack: a compelled gateway could serve a UNIQUE HPKE key per
// client to partition users and re-link sealed sends. We hash the key config we
// fetch and compare to this pin; a mismatch HARD-FAILS the sealed path (never seal
// to an unpinned key) and surfaces a user-visible warning. Published on the
// /transparency page. It is baked as a committed CONSTANT (not just an env var) so
// pinning can NEVER be silently off in a prod build — the value is non-secret
// (derived from the already-published public key). `VITE_SEAL_KEYCONFIG_HASH`
// overrides it for a rotation window. Rotating the gateway keypair REQUIRES
// updating this constant + redeploying the client (see docs/RELAY_ONBOARDING.md).
const DEFAULT_KEYCONFIG_PIN = 'Bso9x6k3uVzzLCOVMUHke6zmsxbObYqsGCwPhnlgDGk=';
const KEYCONFIG_PIN: string = viteEnv.VITE_SEAL_KEYCONFIG_HASH || DEFAULT_KEYCONFIG_PIN;

// Distinct error so callers can tell a key-pin failure (do NOT fall back to the
// relay — a swapped key is the attack, not a transport hiccup) from a transport
// error (which may fall back).
class KeyPinMismatchError extends Error {}

async function sha256Base64(s: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', utf8.encode(s));
	return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

// Fetch + pin-check the gateway key config (always same-origin — a public static
// value; deliberately not relayed) and return the deserialized public key. Throws
// KeyPinMismatchError on a pin mismatch, after warning the user.
async function getGatewayKey(): Promise<CryptoKey> {
	const cfg = (await (await fetch('/api/seal/keys')).json()) as { publicKey: string };
	if (KEYCONFIG_PIN) {
		const observed = await sha256Base64(cfg.publicKey);
		if (observed !== KEYCONFIG_PIN) {
			// Loud, user-visible: a mismatch means the gateway is serving a key the
			// client build never pinned — possible key-substitution attack, or a
			// stale client after a legitimate rotation. Either way, refuse to seal.
			console.error('[sealedFetch] gateway key-config hash MISMATCH — refusing to seal to an unpinned key.');
			if (typeof window !== 'undefined') {
				window.dispatchEvent(new CustomEvent('flatfold:seal-keypin-mismatch'));
			}
			throw new KeyPinMismatchError('key-config pin mismatch');
		}
	}
	return suite.kem.deserializePublicKey(base64ToBytes(cfg.publicKey).buffer);
}

// POST an encapsulated body to the primary relay with EXACTLY the Content-Type the
// oblivious.network relay requires (it rejects anything else, and forwards only
// Content-Type/Content-Length — every other request header is dropped relay-side).
// On a transport failure only — fetch rejects (network/CORS) or a non-2xx status —
// retry ONCE via the Tier-1 fallback with a non-blocking console warning. An
// OHTTP/application-level failure (a 2xx whose sealed body won't decrypt) is NOT a
// relay problem and does not fall back. With no fallback configured, a primary
// failure propagates (send) / is surfaced by the caller (fetchBundle).
async function postSealed(body: Uint8Array): Promise<Response> {
	const opts: RequestInit = { method: 'POST', body: body as BodyInit, credentials: 'omit', headers: { 'Content-Type': 'message/ohttp-req' } };
	try {
		const res = await fetch(SEAL_ENDPOINT, opts);
		if (res.ok || !RELAY_FALLBACK_URL) return res;
		console.warn(`[sealedFetch] relay returned ${res.status}; retrying once via fallback relay`);
		return await fetch(RELAY_FALLBACK_URL, opts);
	} catch (e) {
		if (!RELAY_FALLBACK_URL) throw e;
		console.warn('[sealedFetch] relay request failed; retrying once via fallback relay', e);
		return await fetch(RELAY_FALLBACK_URL, opts);
	}
}

// HPKE-encapsulate {recipient, token, envelope} to the gateway and POST it — the
// sealed SEND path. The gateway (having no sender identity and, behind a relay,
// no client IP) validates the token at the recipient's mailbox and delivers the
// from-less envelope. Returns true if the gateway accepted the POST (a 202 —
// which is uniform regardless of token validity, so this is NOT delivery
// confirmation; that comes later over the sealed delivered-receipt). Throws only
// on a transport/HPKE failure so the caller can fall back to the normal path.
// The `envelope` MUST be from-less: either a message frame (increment 5) or a
// sealed delivered-receipt frame (increment 6). The gateway forwards it opaquely.
export async function apiSealedSend(recipient: string, token: string, envelope: WsMessageFrame | WsDeliveredFrame): Promise<boolean> {
	const gatewayKey = await getGatewayKey();

	const sender = await suite.createSenderContext({ recipientPublicKey: gatewayKey });
	const inner = utf8.encode(JSON.stringify({ op: 'send', recipient, token, envelope }));
	const ct = new Uint8Array(await sender.seal(inner.buffer));
	const enc = new Uint8Array(sender.enc);
	const body = new Uint8Array(enc.length + ct.length);
	body.set(enc, 0);
	body.set(ct, enc.length);

	const res = await postSealed(body);
	return res.status === 202;
}

export type AnonymousBundleResult =
	| { status: 'ok'; bundle: PreKeyBundleResponse }
	| { status: 'not-found' } // unknown user OR user with no published keys (indistinguishable by design)
	| { status: 'error' }; // transport / decrypt failure — caller may fall back to the authenticated fetch

// Fetch `contact`'s prekey bundle anonymously. Never throws — returns a status
// the caller branches on (mirrors apiFetchBundle's result-type style).
export async function apiFetchBundleAnonymous(contact: string): Promise<AnonymousBundleResult> {
	try {
		const gatewayKey = await getGatewayKey();

		const sender = await suite.createSenderContext({ recipientPublicKey: gatewayKey });
		const inner = utf8.encode(JSON.stringify({ op: 'fetchBundle', contact }));
		const ct = new Uint8Array(await sender.seal(inner.buffer));
		const enc = new Uint8Array(sender.enc);
		const body = new Uint8Array(enc.length + ct.length);
		body.set(enc, 0);
		body.set(ct, enc.length);

		// postSealed omits credentials — the whole point is that the server can't
		// tie this lookup to our authenticated session.
		const res = await postSealed(body);
		const blob = new Uint8Array(await res.arrayBuffer());
		if (blob.length < SEALED_RESPONSE_EXPORT_LENGTH) return { status: 'error' }; // no sealed body came back

		const secret = new Uint8Array(await sender.export(EXPORT_LABEL, SEALED_RESPONSE_EXPORT_LENGTH));
		const plaintext = await openResponse(secret, enc, blob);
		const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as { notFound?: boolean } & Partial<PreKeyBundleResponse>;
		if (parsed.notFound || !parsed.identityPubkey || !parsed.signedPrekey) return { status: 'not-found' };
		return {
			status: 'ok',
			bundle: {
				identityPubkey: parsed.identityPubkey,
				signedPrekey: parsed.signedPrekey,
				oneTimePreKey: parsed.oneTimePreKey ?? null,
				sealToken: parsed.sealToken ?? null,
			},
		};
	} catch {
		return { status: 'error' };
	}
}
