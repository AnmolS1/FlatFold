// Post-build: pin the app shell for the service-worker integrity check (H1).
// Computes sha256-<base64> for every Vite-content-hashed asset (/assets/*) plus
// /theme-init.js, and injects the manifest into the built dist/client/sw.js
// (replacing the empty `const SHELL_MANIFEST = {}` placeholder). The digest
// format matches src/sw/shellIntegrity.ts and public/sw.js exactly.
//
// index.html and sw.js itself are intentionally NOT pinned: index.html is the
// network-first navigation shell, and the SW can't meaningfully pin itself
// (that's the stated residual — the server serves the SW too).
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const DIST = 'dist/client';
const PLACEHOLDER = 'const SHELL_MANIFEST = {};';

const shell = {};
async function pin(filePath, urlPath) {
	const buf = await readFile(filePath);
	shell[urlPath] = 'sha256-' + createHash('sha256').update(buf).digest('base64');
}

for (const f of await readdir(join(DIST, 'assets'))) {
	await pin(join(DIST, 'assets', f), '/assets/' + f);
}
await pin(join(DIST, 'theme-init.js'), '/theme-init.js');

const swPath = join(DIST, 'sw.js');
const sw = await readFile(swPath, 'utf8');
if (!sw.includes(PLACEHOLDER)) {
	throw new Error(`gen-sw-manifest: placeholder "${PLACEHOLDER}" not found in ${swPath}`);
}
const injected = 'const SHELL_MANIFEST = ' + JSON.stringify(shell) + ';';
await writeFile(swPath, sw.replace(PLACEHOLDER, injected));
console.log(`gen-sw-manifest: pinned ${Object.keys(shell).length} shell assets into ${swPath}`);
