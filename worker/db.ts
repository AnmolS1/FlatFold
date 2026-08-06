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
	// Opt-in account recovery (migration 0008). All NULL until the user enrolls a
	// recovery code. recovery_blob is the identity keys + contacts encrypted under
	// a code-derived key (opaque to the server); recovery_verifier authenticates a
	// recovery request; the salts are public. See worker/index.ts recovery routes.
	recovery_verifier: string | null;
	recovery_blob: string | null;
	recovery_salt_rec: string | null;
	recovery_salt_auth: string | null;
	// Opt-in TOTP two-factor (migration 0009). All NULL until enrolled.
	// totp_secret is encrypted at rest; backup_code_hashes is a JSON array of
	// salted hashes; totp_last_step is the replay high-water mark. See worker/totp.
	totp_secret: string | null;
	backup_code_hashes: string | null;
	totp_last_step: number | null;
	// In-app terms acceptance (migration 0010). NULL until accepted, including for
	// every account that existed before the migration — the gate is retroactive on
	// purpose. `terms_version` is written by the server from shared/terms.ts, never
	// from the request, so acceptance of an older revision can be re-gated.
	terms_accepted_at: number | null;
	terms_version: string | null;
	// Account termination (migration 0012). NULL for every ordinary account. When
	// set, authentication fails everywhere immediately — including sessions that
	// were already open, so actioning an abusive account does not wait out its
	// token. The handle is retired separately, in `banned_usernames`.
	disabled_at: number | null;
}

// Record that this user accepted the terms. `version` is the SERVER's constant —
// the caller must not pass anything client-supplied here, or an account could
// store a future version and skip the next re-gate.
export async function setTermsAccepted(db: D1Database, username: string, acceptedAt: number, version: string): Promise<void> {
	await db
		.prepare('UPDATE users SET terms_accepted_at = ?, terms_version = ? WHERE username = ?')
		.bind(acceptedAt, version, username)
		.run();
}

// Whether this user has accepted the CURRENT terms. An older accepted version
// counts as not accepted — that is what makes bumping TERMS_VERSION re-gate
// everyone rather than being decorative.
export function hasAcceptedTerms(user: UserRow, currentVersion: string): boolean {
	return user.terms_accepted_at !== null && user.terms_version === currentVersion;
}

// L3: bump the user's session epoch, invalidating every token issued before now.
export async function bumpTokenEpoch(db: D1Database, username: string): Promise<void> {
	await db.prepare('UPDATE users SET token_epoch = token_epoch + 1 WHERE username = ?').bind(username).run();
}

// Change password (D7 §1): swap the verifier AND bump the epoch in ONE statement
// so the two can't diverge on a crash — a verifier-changed-but-epoch-not state
// would leave old sessions alive under the new password. The epoch bump kills
// every existing session (the caller re-issues a fresh token at the new epoch).
export async function updatePassword(db: D1Database, username: string, newVerifier: string): Promise<void> {
	await db
		.prepare('UPDATE users SET password_verifier = ?, token_epoch = token_epoch + 1 WHERE username = ?')
		.bind(newVerifier, username)
		.run();
}

// Enroll (or replace) a user's recovery material (D7 §3). All four values are
// set together; a re-enroll overwrites the prior code.
export async function setRecovery(
	db: D1Database,
	username: string,
	params: { verifier: string; blob: string; saltRec: string; saltAuth: string }
): Promise<void> {
	await db
		.prepare(
			'UPDATE users SET recovery_verifier = ?, recovery_blob = ?, recovery_salt_rec = ?, recovery_salt_auth = ? WHERE username = ?'
		)
		.bind(params.verifier, params.blob, params.saltRec, params.saltAuth, username)
		.run();
}

// The PUBLIC recovery salts for a username, so a new device can re-derive the
// recovery keys. Null when the user hasn't enrolled recovery (or doesn't exist).
export async function getRecoveryParams(
	db: D1Database,
	username: string
): Promise<{ saltRec: string; saltAuth: string } | null> {
	const row = await db
		.prepare('SELECT recovery_salt_rec, recovery_salt_auth FROM users WHERE username = ?')
		.bind(username)
		.first<{ recovery_salt_rec: string | null; recovery_salt_auth: string | null }>();
	if (!row || row.recovery_salt_rec === null || row.recovery_salt_auth === null) return null;
	return { saltRec: row.recovery_salt_rec, saltAuth: row.recovery_salt_auth };
}

// Enable (or replace) TOTP two-factor: the encrypted secret + JSON backup hashes,
// resetting the replay counter. (D7 §4)
export async function setTotp(
	db: D1Database,
	username: string,
	params: { encSecret: string; backupHashes: string[] }
): Promise<void> {
	await db
		.prepare('UPDATE users SET totp_secret = ?, backup_code_hashes = ?, totp_last_step = NULL WHERE username = ?')
		.bind(params.encSecret, JSON.stringify(params.backupHashes), username)
		.run();
}

// Disable TOTP — clears the secret, backup codes, and replay counter together.
export async function clearTotp(db: D1Database, username: string): Promise<void> {
	await db
		.prepare('UPDATE users SET totp_secret = NULL, backup_code_hashes = NULL, totp_last_step = NULL WHERE username = ?')
		.bind(username)
		.run();
}

// Advance the replay high-water mark after a TOTP code is accepted.
export async function setTotpLastStep(db: D1Database, username: string, step: number): Promise<void> {
	await db.prepare('UPDATE users SET totp_last_step = ? WHERE username = ?').bind(step, username).run();
}

// Persist the remaining backup-code hashes after one is consumed.
export async function setBackupCodeHashes(db: D1Database, username: string, hashes: string[]): Promise<void> {
	await db.prepare('UPDATE users SET backup_code_hashes = ? WHERE username = ?').bind(JSON.stringify(hashes), username).run();
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

// How many unconsumed one-time prekeys this user has left. Drives client-side
// replenishment: the pool is finite and consumed one per first contact, so
// without a top-up an ordinary account runs dry after its initial batch and
// every later contact degrades to no-OTP X3DH. Read-only, no schema change.
export async function countOneTimePreKeys(db: D1Database, username: string): Promise<number> {
	const row = await db
		.prepare('SELECT COUNT(*) AS n FROM one_time_prekeys WHERE username = ?')
		.bind(username)
		.first<{ n: number }>();
	return row?.n ?? 0;
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
// user — the account, its one-time prekeys, its push subscriptions (Web Push
// AND APNs), and its rate-limit counters (bundle-lookup, login, and signup
// keys) — in one atomic batch. The mailbox DO's queued ciphertext is purged
// separately (see worker/account.ts). Nothing is soft-deleted.
export async function deleteUserData(db: D1Database, username: string): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM one_time_prekeys WHERE username = ?').bind(username),
		db.prepare('DELETE FROM push_subscriptions WHERE username = ?').bind(username),
		db.prepare('DELETE FROM apns_subscriptions WHERE username = ?').bind(username),
		db.prepare('DELETE FROM rate_limits WHERE requester IN (?, ?, ?)').bind(username, `login:${username}`, `signup:${username}`),
		db.prepare('DELETE FROM users WHERE username = ?').bind(username),
	]);
}
