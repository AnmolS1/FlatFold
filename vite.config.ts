import { defineConfig } from 'vite'
import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

// https://vite.dev/config/
// Stamped into the bundle so a running app can say WHICH build it is. This is
// not vanity: WKWebView keeps the old JavaScript across a native rebuild unless
// the app is force-quit, and the web build is pinned by a service worker. Two
// separate bug reports (Touch ID "not enabling", swipe-to-reply "broken") turned
// out to be a stale bundle, and there was no way to tell from inside the app.
const BUILD_ID = (() => {
	try {
		const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
		const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() ? '+' : '';
		return `${sha}${dirty}`;
	} catch {
		return 'unknown';
	}
})();

export default defineConfig({
	define: {
		__BUILD_ID__: JSON.stringify(BUILD_ID),
		__BUILT_AT__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
	},
	plugins: [react(), tailwindcss(), cloudflare()],
})
