// Key publish + prekey-bundle-fetch endpoints — X3DH's server-side surface.
// The server never sees a secret key; it only stores and hands back public
// material.
//
// Known gap, not yet built: the rebuild brief calls for hard rate-limiting
// on bundle lookups ("does this exact username exist" is itself a small
// oracle, even though usernames are meant to be looked-up-by-design here —
// the risk is enumeration *speed*, not existence). Deferred to the M7
// hardening pass; tracked here rather than silently absent.

import {
	addOneTimePreKeys,
	checkRateLimit,
	consumeOneTimePreKey,
	countOneTimePreKeys,
	getUser,
	setUserKeys,
	type IdentityPubkeyJson,
	type SignedPrekeyJson,
} from './db';

// A requester may fetch at most this many prekey bundles per window — hard
// enough to throttle username enumeration, loose enough to never bother a
// human adding contacts.
const BUNDLE_LOOKUP_LIMIT = 30;
const BUNDLE_LOOKUP_WINDOW_SECONDS = 60;
const MAX_ONE_TIME_PREKEYS = 200; // L5: cap a single publish batch
// M2: one requester may consume at most this many OTPs per target per window.
// Repeat lookups in the window return no fresh OTP (the client falls back to the
// authenticated no-OTP X3DH), so a few accounts can't loop this endpoint to drain
// a victim's prekey pool. A stronger fix (signed last-resort prekey) is noted in
// docs/SECURITY_AUDIT.md as the recommended follow-up.
const OTP_CLAIM_WINDOW_SECONDS = 3600;
const OTP_CLAIM_LIMIT_PER_WINDOW = 1;
// Ceiling on a user's STORED pool, so repeated top-ups can't grow the table
// without bound (a client bug or a malicious client could otherwise keep
// inserting). Comfortably above the client's target so normal replenishment
// never bumps it.
const MAX_STORED_ONE_TIME_PREKEYS = 100;

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { 'Content-Type': 'application/json', ...init.headers },
	});
}

function isIdentityPubkey(value: unknown): value is IdentityPubkeyJson {
	const v = value as Partial<IdentityPubkeyJson> | null;
	return !!v && typeof v.signingPublicKey === 'string' && typeof v.dhPublicKey === 'string';
}

function isSignedPrekey(value: unknown): value is SignedPrekeyJson {
	const v = value as Partial<SignedPrekeyJson> | null;
	return !!v && typeof v.publicKey === 'string' && typeof v.signature === 'string';
}

export async function handlePublishKeys(request: Request, env: Env, username: string): Promise<Response> {
	const body = await request.json().catch(() => null);
	const identityPubkey = (body as { identityPubkey?: unknown } | null)?.identityPubkey;
	const signedPrekey = (body as { signedPrekey?: unknown } | null)?.signedPrekey;
	const oneTimePreKeys = (body as { oneTimePreKeys?: unknown } | null)?.oneTimePreKeys;

	if (!isIdentityPubkey(identityPubkey) || !isSignedPrekey(signedPrekey)) {
		return json({ error: 'Malformed key material.' }, { status: 400 });
	}
	if (!Array.isArray(oneTimePreKeys) || !oneTimePreKeys.every((k) => typeof k === 'string')) {
		return json({ error: 'oneTimePreKeys must be an array of strings.' }, { status: 400 });
	}
	// L5: cap the batch so a single publish can't insert an unbounded pool.
	if (oneTimePreKeys.length > MAX_ONE_TIME_PREKEYS) {
		return json({ error: `oneTimePreKeys must be at most ${MAX_ONE_TIME_PREKEYS}.` }, { status: 400 });
	}

	await setUserKeys(env.DB, username, identityPubkey, signedPrekey);
	const createdAt = Math.floor(Date.now() / 1000);
	await addOneTimePreKeys(env.DB, username, oneTimePreKeys, createdAt);
	// The sealed-sender delivery token is NOT set here: publish also INSERTs
	// one-time prekeys, so it's a bad vehicle for token updates (would pile up
	// OPKs on every rotation). The single writer is /api/seal/register-token,
	// which updates both the recipient DO and the D1 bundle copy.

	return json({ ok: true });
}

// How many one-time prekeys the caller has left. The client polls this at
// startup and tops the pool up when it runs low — without that, the initial
// batch is consumed one-per-first-contact and never replaced, so an ordinary
// account degrades to no-OTP X3DH permanently (FULL_AUDIT §2).
export async function handleGetPreKeyCount(env: Env, username: string): Promise<Response> {
	return json({ remaining: await countOneTimePreKeys(env.DB, username) });
}

// Top up ONLY the one-time prekey pool. Deliberately separate from
// /api/keys/publish: that endpoint also rewrites the identity and signed
// prekey, and re-publishing those on every replenishment would look like a key
// change to every contact. This adds prekeys and touches nothing else.
export async function handleAddOneTimePreKeys(request: Request, env: Env, username: string): Promise<Response> {
	const body = await request.json().catch(() => null);
	const oneTimePreKeys = (body as { oneTimePreKeys?: unknown } | null)?.oneTimePreKeys;

	if (!Array.isArray(oneTimePreKeys) || !oneTimePreKeys.every((k) => typeof k === 'string')) {
		return json({ error: 'oneTimePreKeys must be an array of strings.' }, { status: 400 });
	}
	if (oneTimePreKeys.length > MAX_ONE_TIME_PREKEYS) {
		return json({ error: `oneTimePreKeys must be at most ${MAX_ONE_TIME_PREKEYS}.` }, { status: 400 });
	}

	// Clamp against the stored ceiling rather than rejecting: a client that
	// over-asks still gets topped up to the cap, and the extra local secrets it
	// keeps are harmless (they simply never get claimed).
	const existing = await countOneTimePreKeys(env.DB, username);
	const room = Math.max(0, MAX_STORED_ONE_TIME_PREKEYS - existing);
	const accepted = oneTimePreKeys.slice(0, room);

	if (accepted.length > 0) {
		await addOneTimePreKeys(env.DB, username, accepted, Math.floor(Date.now() / 1000));
	}
	return json({ remaining: existing + accepted.length, accepted: accepted.length });
}

// Anonymous (sealed-sender) bundle lookup used by the OHTTP gateway. There is
// NO authenticated requester on the sealed path, so — deliberately — this does
// NOT consume a one-time prekey (an unauthenticated caller could otherwise drain
// a victim's pool) and does NOT apply the requester-keyed rate limit (nothing to
// key on). A no-one-time-prekey X3DH is fully supported (just weaker first-
// message forward secrecy — a documented tradeoff), so the bundle omits the OTP.
// Returns null when the user is unknown or hasn't published key material; the
// gateway seals a length-uniform "not found" sentinel for that case (non-oracle).
export async function lookupBundleForSeal(
	env: Env,
	contactUsername: string
): Promise<{ identityPubkey: IdentityPubkeyJson; signedPrekey: SignedPrekeyJson; oneTimePreKey: null; sealToken: string | null } | null> {
	const user = await getUser(env.DB, contactUsername);
	if (!user || !user.identity_pubkey || !user.signed_prekey) return null;
	return {
		identityPubkey: JSON.parse(user.identity_pubkey) as IdentityPubkeyJson,
		signedPrekey: JSON.parse(user.signed_prekey) as SignedPrekeyJson,
		oneTimePreKey: null,
		sealToken: user.seal_token ?? null,
	};
}

export async function handleGetBundle(env: Env, requesterUsername: string, contactUsername: string): Promise<Response> {
	const windowStart = Math.floor(Date.now() / 1000 / BUNDLE_LOOKUP_WINDOW_SECONDS) * BUNDLE_LOOKUP_WINDOW_SECONDS;
	const allowed = await checkRateLimit(env.DB, requesterUsername, windowStart, BUNDLE_LOOKUP_LIMIT);
	if (!allowed) return json({ error: 'Too many lookups. Please slow down.' }, { status: 429 });

	const user = await getUser(env.DB, contactUsername);
	if (!user) return json({ error: 'No such user.' }, { status: 404 });
	if (!user.identity_pubkey || !user.signed_prekey) {
		return json({ error: 'That user has not published key material yet.' }, { status: 409 });
	}

	// M2: only consume a fresh OTP on this requester's FIRST lookup of this target
	// in the window; repeats get no OTP (authenticated no-OTP X3DH still works).
	const otpWindow = Math.floor(Date.now() / 1000 / OTP_CLAIM_WINDOW_SECONDS) * OTP_CLAIM_WINDOW_SECONDS;
	const mayConsumeOtp = await checkRateLimit(env.DB, `otpclaim:${requesterUsername}:${contactUsername}`, otpWindow, OTP_CLAIM_LIMIT_PER_WINDOW);
	const oneTimePreKey = mayConsumeOtp ? await consumeOneTimePreKey(env.DB, contactUsername) : null;

	return json({
		identityPubkey: JSON.parse(user.identity_pubkey) as IdentityPubkeyJson,
		signedPrekey: JSON.parse(user.signed_prekey) as SignedPrekeyJson,
		oneTimePreKey,
		sealToken: user.seal_token ?? null,
	});
}
