// App-shell integrity pin — the security-critical decision logic for the
// service worker (H1). At build time `scripts/gen-sw-manifest.mjs` writes a
// manifest of {shell path -> sha256-<base64>} into the deployed sw.js. At runtime
// the SW hashes each shell asset it is about to cache/serve and refuses to cache
// or serve one whose bytes don't match its pinned digest, surfacing a visible
// warning instead. This catches a SILENTLY SWAPPED BUNDLE (attacker changes an
// /assets/* file but not the SW). It is NOT a full guarantee: the SW and
// index.html are themselves server-supplied, so a coordinated server could
// replace the SW itself — that residual is stated on /transparency and in sw.js.
//
// This module is the tested source of truth; public/sw.js inlines the same
// algorithm (a classic service worker can't import ES modules).

// SHA-256 of the bytes as "sha256-<base64>", matching the manifest format.
export async function assetDigest(bytes: ArrayBuffer | Uint8Array): Promise<string> {
	const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf as BufferSource));
	let bin = '';
	for (const b of digest) bin += String.fromCharCode(b);
	return `sha256-${btoa(bin)}`;
}

export interface ShellVerdict {
	// Whether this path is pinned in the manifest at all.
	pinned: boolean;
	// Whether it is safe to cache/serve: true if unpinned, or pinned-and-matching.
	ok: boolean;
}

// Decide how to handle a fetched shell asset against the pinned manifest.
export async function verifyShellAsset(
	path: string,
	bytes: ArrayBuffer | Uint8Array,
	manifest: Record<string, string>
): Promise<ShellVerdict> {
	const pin = manifest[path];
	if (!pin) return { pinned: false, ok: true }; // unpinned (dev, or non-shell) — handle as before
	const digest = await assetDigest(bytes);
	return { pinned: true, ok: digest === pin };
}
