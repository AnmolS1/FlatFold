// Encrypted-attachment relay. The server stores and returns ONLY ciphertext
// under a random id — it never sees a decryption key, a filename, or a MIME
// type (all of that rides inside the E2EE message as a MediaRef). This file
// plus the R2 binding are the entire attachment surface.
//
// Lifecycle: an object is deleted on fetch-ack (the recipient DELETEs it once
// it has downloaded + verified + decrypted), mirroring the message ack model.
// A 14-day hard TTL is a deploy-time R2 lifecycle rule (documented; not
// simulated locally) — the fetch-ack deletion is the path that actually runs
// in local dev.

const MAX_CIPHERTEXT_BYTES = 25 * 1024 * 1024; // 25 MiB ciphertext cap

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { 'Content-Type': 'application/json', ...init.headers },
	});
}

// POST /api/media  — body is raw ciphertext bytes; returns { id }.
export async function handleMediaUpload(request: Request, env: Env): Promise<Response> {
	const body = await request.arrayBuffer();
	if (body.byteLength === 0) return json({ error: 'Empty body.' }, { status: 400 });
	if (body.byteLength > MAX_CIPHERTEXT_BYTES) return json({ error: 'Attachment too large.' }, { status: 413 });

	const id = crypto.randomUUID();
	await env.MEDIA.put(id, body);
	return json({ id });
}

// GET /api/media/:id  — returns the raw ciphertext, or 404.
export async function handleMediaDownload(env: Env, id: string): Promise<Response> {
	const object = await env.MEDIA.get(id);
	if (!object) return json({ error: 'Not found.' }, { status: 404 });
	return new Response(object.body, {
		headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
	});
}

// DELETE /api/media/:id  — fetch-ack deletion. Idempotent (deleting a
// missing object is a no-op 204).
export async function handleMediaDelete(env: Env, id: string): Promise<Response> {
	await env.MEDIA.delete(id);
	return new Response(null, { status: 204 });
}
