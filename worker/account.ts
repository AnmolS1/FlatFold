// Account deletion (invariant #6: "Deleting an account deletes everything —
// keys, queued envelopes, prekeys, the D1 row — synchronously, not
// soft-delete"). Because this is irreversible and destructive, it requires
// PASSWORD re-authentication, not just the session cookie: a stolen 15-minute
// session must not be able to nuke the account.

import { buildClearSessionCookie, verifyPassword } from './auth';
import { deleteUserData, getUser } from './db';

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
}

// `username` is already the authenticated session user. We additionally
// require the password so a hijacked session can't delete the account.
export async function handleDeleteAccount(request: Request, env: Env, username: string): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
	const password = body?.password;
	if (typeof password !== 'string' || password.length === 0) {
		return json({ error: 'Password required to delete your account.' }, { status: 400 });
	}

	const user = await getUser(env.DB, username);
	if (!user || !(await verifyPassword(password, user.password_verifier))) {
		// Generic — don't leak whether the account exists.
		return json({ error: 'Incorrect password.' }, { status: 401 });
	}

	// 1. Purge the user's mailbox DO (queued ciphertext, counters, TTL alarm,
	//    live socket). Synchronous — awaited before we report success.
	await env.MAILBOX.getByName(username).fetch('https://internal/purge', { method: 'POST' });

	// 2. Delete every D1 row for the user, atomically.
	await deleteUserData(env.DB, username);

	// 3. Clear the session cookie. The client wipes its local keystore itself.
	return json({ ok: true }, { headers: { 'Set-Cookie': buildClearSessionCookie() } });
}
