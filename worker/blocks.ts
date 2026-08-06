// Server-side blocking, and account termination (App Review 1.2).
//
// Blocking already existed client-side (src/lib/blocklist.ts) and still does —
// it is what catches a SEALED send, where the server genuinely cannot know who
// the sender is. What this adds is refusal at the mailbox on the normal path, so
// a blocked account cannot deliver at all, the block applies on every device, and
// it survives a reinstall. Both layers, each covering what the other cannot.
import { checkRateLimit } from './db';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const BLOCK_LIMIT = 60;
const BLOCK_WINDOW_SECONDS = 3600;

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { 'Content-Type': 'application/json', ...init.headers },
	});
}

/** Does `recipient` block `sender`? Consulted on the delivery path. */
export async function isBlockedServerSide(db: D1Database, recipient: string, sender: string): Promise<boolean> {
	const row = await db
		.prepare('SELECT 1 AS hit FROM blocks WHERE blocker = ? AND blocked = ?')
		.bind(recipient, sender)
		.first<{ hit: number }>();
	return row !== null;
}

export async function listBlocks(db: D1Database, blocker: string): Promise<string[]> {
	const result = await db
		.prepare('SELECT blocked FROM blocks WHERE blocker = ? ORDER BY blocked')
		.bind(blocker)
		.all<{ blocked: string }>();
	return (result.results ?? []).map((r) => r.blocked);
}

export async function handleListBlocks(env: Env, username: string): Promise<Response> {
	return json({ blocked: await listBlocks(env.DB, username) });
}

export async function handleBlock(request: Request, env: Env, username: string): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { username?: unknown } | null;
	const target = body?.username;
	if (typeof target !== 'string' || !USERNAME_RE.test(target) || target === username) {
		return json({ error: 'Invalid username.' }, { status: 400 });
	}

	const window = Math.floor(Date.now() / 1000 / BLOCK_WINDOW_SECONDS) * BLOCK_WINDOW_SECONDS;
	if (!(await checkRateLimit(env.DB, `block:${username}`, window, BLOCK_LIMIT))) {
		return json({ error: 'Too many changes just now. Please try again later.' }, { status: 429 });
	}

	// Idempotent: blocking someone twice is a no-op, not an error. The client
	// re-syncs its local list on sign-in, so repeats are expected traffic.
	await env.DB.prepare('INSERT OR IGNORE INTO blocks (blocker, blocked, created_at) VALUES (?, ?, ?)')
		.bind(username, target, Math.floor(Date.now() / 60_000) * 60)
		.run();
	return json({ ok: true });
}

export async function handleUnblock(request: Request, env: Env, username: string): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { username?: unknown } | null;
	const target = body?.username;
	if (typeof target !== 'string' || !USERNAME_RE.test(target)) {
		return json({ error: 'Invalid username.' }, { status: 400 });
	}
	await env.DB.prepare('DELETE FROM blocks WHERE blocker = ? AND blocked = ?').bind(username, target).run();
	return json({ ok: true });
}

/** Is this handle retired after a termination? Checked at signup. */
export async function isUsernameBanned(db: D1Database, username: string): Promise<boolean> {
	const row = await db.prepare('SELECT 1 AS hit FROM banned_usernames WHERE username = ?').bind(username).first();
	return row !== null;
}
