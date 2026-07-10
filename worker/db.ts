// Thin D1 query helpers for the `users` table. This file plus
// migrations/0001_init.sql define the entire persistent data model — see
// docs/ARCHITECTURE.md for the auditability claim this supports.

export interface UserRow {
	username: string;
	password_verifier: string;
	identity_pubkey: string | null;
	signed_prekey: string | null;
	created_at: number;
	// Sealed-sender delivery token (migration 0005). Public; served in the
	// bundle. Nullable — an account has no token until it publishes one.
	seal_token: string | null;
	// Session epoch (migration 0006). Folded into the session token; bumped to
	// revoke all sessions ("Sign out everywhere"). See worker/auth.ts.
	token_epoch: number;
}

// L3: bump the user's session epoch, invalidating every token issued before now.
export async function bumpTokenEpoch(db: D1Database, username: string): Promise<void> {
	await db.prepare('UPDATE users SET token_epoch = token_epoch + 1 WHERE username = ?').bind(username).run();
}

export async function getUser(db: D1Database, username: string): Promise<UserRow | null> {
	const row = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<UserRow>();
	return row ?? null;
}

export async function createUser(
	db: D1Database,
	params: { username: string; passwordVerifier: string; createdAt: number }
): Promise<void> {
	await db
		.prepare('INSERT INTO users (username, password_verifier, created_at) VALUES (?, ?, ?)')
		.bind(params.username, params.passwordVerifier, params.createdAt)
		.run();
}

// identity_pubkey / signed_prekey are each a single TEXT column holding a
// packed JSON object — not a schema change per key field, just structured
// content in the columns 0001_init.sql already declared.
export interface IdentityPubkeyJson {
	signingPublicKey: string;
	dhPublicKey: string;
}

export interface SignedPrekeyJson {
	publicKey: string;
	signature: string;
}

export async function setUserKeys(
	db: D1Database,
	username: string,
	identityPubkey: IdentityPubkeyJson,
	signedPrekey: SignedPrekeyJson
): Promise<void> {
	await db
		.prepare('UPDATE users SET identity_pubkey = ?, signed_prekey = ? WHERE username = ?')
		.bind(JSON.stringify(identityPubkey), JSON.stringify(signedPrekey), username)
		.run();
}

// Publish (or rotate) this user's sealed-sender delivery token. Idempotent —
// the client re-publishes the current token on every login to converge the D1
// copy with the recipient DO's authoritative valid set. A null clears it.
export async function setUserSealToken(db: D1Database, username: string, sealToken: string | null): Promise<void> {
	await db.prepare('UPDATE users SET seal_token = ? WHERE username = ?').bind(sealToken, username).run();
}

export async function addOneTimePreKeys(
	db: D1Database,
	username: string,
	publicKeys: string[],
	createdAt: number
): Promise<void> {
	if (publicKeys.length === 0) return;
	const stmt = db.prepare('INSERT INTO one_time_prekeys (username, public_key, created_at) VALUES (?, ?, ?)');
	await db.batch(publicKeys.map((publicKey) => stmt.bind(username, publicKey, createdAt)));
}

// Atomic: the SELECT-then-DELETE happens as a single SQL statement (one D1
// round trip), so two concurrent bundle fetches for the same user can never
// both claim the same one-time prekey — a read-then-separate-delete would
// race under concurrent requests.
export async function consumeOneTimePreKey(db: D1Database, username: string): Promise<string | null> {
	const row = await db
		.prepare(
			`DELETE FROM one_time_prekeys WHERE id = (
				SELECT id FROM one_time_prekeys WHERE username = ? ORDER BY id LIMIT 1
			) RETURNING public_key`
		)
		.bind(username)
		.first<{ public_key: string }>();
	return row?.public_key ?? null;
}

// Fixed-window rate limiter. Atomically increments this requester's counter
// for the current window (the upsert + RETURNING is a single statement, so
// concurrent requests can't lose an increment) and reports whether they're
// still under `limit`. Also opportunistically prunes this requester's stale
// windows so the table stays at ~one row per active requester.
export async function checkRateLimit(
	db: D1Database,
	requester: string,
	windowStart: number,
	limit: number
): Promise<boolean> {
	const row = await db
		.prepare(
			`INSERT INTO rate_limits (requester, window_start, count) VALUES (?, ?, 1)
			 ON CONFLICT(requester, window_start) DO UPDATE SET count = count + 1
			 RETURNING count`
		)
		.bind(requester, windowStart)
		.first<{ count: number }>();

	await db.prepare('DELETE FROM rate_limits WHERE requester = ? AND window_start < ?').bind(requester, windowStart).run();

	return (row?.count ?? limit + 1) <= limit;
}

// Account deletion (invariant #6): synchronously remove EVERY D1 row tied to a
// user — the account, its one-time prekeys, its push subscriptions, and its
// rate-limit counters (bundle-lookup, login, and signup keys) — in one atomic
// batch. The mailbox DO's queued ciphertext is purged separately (see
// worker/account.ts). Nothing is soft-deleted.
export async function deleteUserData(db: D1Database, username: string): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM one_time_prekeys WHERE username = ?').bind(username),
		db.prepare('DELETE FROM push_subscriptions WHERE username = ?').bind(username),
		db.prepare('DELETE FROM rate_limits WHERE requester IN (?, ?, ?)').bind(username, `login:${username}`, `signup:${username}`),
		db.prepare('DELETE FROM users WHERE username = ?').bind(username),
	]);
}
