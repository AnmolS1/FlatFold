// Inject the Content-Security-Policy for the NATIVE bundled context.
//
// public/_headers (the web CSP) does NOT apply to locally-loaded Capacitor
// assets, so the policy must ride as a <meta> tag in the bundled index.html.
// This runs AFTER `vite build`, BEFORE `cap sync`, editing ONLY dist/client
// (never the source index.html — the web build keeps _headers).
//
// The one native-required change vs the web CSP is `'wasm-unsafe-eval'` in
// script-src (Argon2id via hash-wasm) — proven load-bearing in the Phase 0
// spike (removing it fails createIdentity with a WKWebView CompileError).
// connect-src names the API origin(s) the native client actually talks to.
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'dist/client/index.html';
const API = process.env.VITE_API_ORIGIN ?? 'https://flatfold.ponderance.dev';
const WS = API.replace(/^http/, 'ws');

const CSP = [
	"default-src 'none'",
	"script-src 'self' 'wasm-unsafe-eval'",
	"worker-src 'self'",
	"style-src 'self'",
	"img-src 'self' data: blob:",
	"media-src 'self' blob:",
	"font-src 'self'",
	`connect-src 'self' ${API} ${WS}`,
	"manifest-src 'self'",
	"frame-ancestors 'none'",
	"base-uri 'none'",
	"form-action 'self'",
	"object-src 'none'",
].join('; ');

let html = readFileSync(FILE, 'utf8');
if (html.includes('http-equiv="Content-Security-Policy"')) {
	html = html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/g, '');
}
html = html.replace(
	/(<meta charset="[^"]*" \/>)/i,
	`$1\n\t<meta http-equiv="Content-Security-Policy" content="${CSP}" />`
);

// D2 §0.2 — lock the viewport in the NATIVE context only. The source
// index.html keeps a user-zoomable viewport (web a11y: pinch-zoom must work).
// In a bundled native app there is no browser chrome to restore zoom, so we
// pin `maximum-scale=1` (+ `user-scalable=no`): this is the hard guarantee
// that focusing an input never auto-zooms the WKWebView — the root of the
// "tap a field, viewport zooms and sticks" bug class. `interactive-widget`
// stays for Android Chrome (resizes the layout viewport for the keyboard);
// iOS drives its keyboard-aware layout off `visualViewport` (useVisualViewport).
const NATIVE_VIEWPORT =
	'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content';
if (!/<meta name="viewport"[^>]*>/i.test(html)) {
	throw new Error('inject-native-csp: no <meta name="viewport"> found to lock');
}
html = html.replace(/<meta name="viewport"[^>]*>/i, `<meta name="viewport" content="${NATIVE_VIEWPORT}" />`);

writeFileSync(FILE, html);
console.log(`inject-native-csp: meta CSP + locked native viewport written to ${FILE} (connect-src → ${API})`);
