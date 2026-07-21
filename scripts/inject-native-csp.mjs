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
writeFileSync(FILE, html);
console.log(`inject-native-csp: meta CSP written to ${FILE} (connect-src → ${API})`);
