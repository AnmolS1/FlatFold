// FlatFold service worker — deliberately minimal and auditable.
//
// Scope: the APP SHELL ONLY (HTML/JS/CSS/fonts/icons). It NEVER touches
// dynamic or sensitive traffic — `/api/*`, `/ws`, `/api/media/*`, and any
// non-GET or cross-origin request pass straight through to the network,
// untouched and uncached. Caching a token-bearing API response or ciphertext
// would be a data-at-rest leak; caching `/ws` would kill live messaging.
//
// The shell is content-hashed at build time, so hashed assets are immutable
// (cache-first is safe) while navigations are network-first (a new deploy is
// picked up online, cache is only the offline fallback).
//
// APP-SHELL INTEGRITY PIN (H1): `scripts/gen-sw-manifest.mjs` injects a manifest
// of {shell path -> sha256-<base64>} into SHELL_MANIFEST at build time. Before
// caching a pinned asset the SW hashes its bytes and, on a mismatch, refuses to
// cache it and posts `flatfold:integrity-mismatch` to clients (a visible warning),
// so a SILENTLY SWAPPED BUNDLE is caught. HONEST RESIDUAL: the SW and index.html
// are themselves served by the same server, so this raises the bar but does not
// eliminate the web-client trust problem — a coordinated server could replace this
// SW itself. The verification algorithm mirrors src/sw/shellIntegrity.ts (tested).

// Build-injected at deploy (empty in dev / when not injected ⇒ pinning is off).
const SHELL_MANIFEST = {};

const CACHE = 'flatfold-shell-v3';
// A separate, UNVERSIONED cache holding only the user's decoy notification
// label — preserved across shell-cache version bumps (see `activate`). The
// SW can't reach the app's IndexedDB keystore, so a cache entry is how the
// client hands the decoy label to the push handler. No message content ever
// lives here.
const PREFS = 'flatfold-prefs';

// Stable (non-hashed) shell paths worth precaching. Hashed asset bundles
// (/assets/*) are cached on first online fetch by the runtime handler below.
const PRECACHE = ['/', '/index.html', '/theme-init.js', '/manifest.webmanifest', '/favicon.svg'];

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			// Best-effort: a missing path must not abort the whole install.
			.then((cache) => Promise.allSettled(PRECACHE.map((p) => cache.add(p))))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== PREFS).map((k) => caches.delete(k))))
			.then(() => self.clients.claim())
	);
});

function isDynamic(url) {
	return url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname.startsWith('/ws/');
}

self.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return; // never cache mutations

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return; // never touch cross-origin
	if (isDynamic(url)) return; // API / WebSocket / media — network only, untouched

	// Navigations (the app shell HTML): network-first so a fresh deploy is
	// picked up online; fall back to the cached shell offline.
	if (request.mode === 'navigate') {
		event.respondWith(
			fetch(request)
				.then((response) => {
					const copy = response.clone();
					caches.open(CACHE).then((cache) => cache.put('/index.html', copy));
					return response;
				})
				.catch(() => caches.match('/index.html').then((c) => c || caches.match('/')))
		);
		return;
	}

	// Content-hashed assets, fonts, icons: cache-first (immutable), then network.
	// Pinned shell assets are integrity-checked before they're cached.
	event.respondWith(handleAsset(request, url.pathname));
});

// SHA-256 of bytes as "sha256-<base64>" — mirrors src/sw/shellIntegrity.ts.
async function assetDigest(buf) {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
	let bin = '';
	for (const b of digest) bin += String.fromCharCode(b);
	return 'sha256-' + btoa(bin);
}

async function notifyIntegrityMismatch(path) {
	try {
		const clients = await self.clients.matchAll({ includeUncontrolled: true });
		for (const c of clients) c.postMessage({ type: 'flatfold:integrity-mismatch', path });
	} catch {
		/* clients unavailable — nothing to warn */
	}
}

async function handleAsset(request, path) {
	const cache = await caches.open(CACHE);
	// Only verified bytes are ever cached, so a hit is trusted.
	const cached = await cache.match(request);
	if (cached) return cached;

	const response = await fetch(request);
	if (!(response.ok && response.type === 'basic')) return response;

	const pin = SHELL_MANIFEST[path];
	if (pin) {
		const buf = await response.clone().arrayBuffer();
		if ((await assetDigest(buf)) !== pin) {
			// Pinned asset's bytes don't match this SW's manifest: a silently swapped
			// bundle (or a stale SW after a deploy). Do NOT cache it; warn clients.
			await notifyIntegrityMismatch(path);
			return response; // can't manufacture correct bytes; surface + don't persist
		}
	}
	await cache.put(request, response.clone());
	return response;
}

// ---- Web Push (M6). Content-free by construction: FlatFold sends a
// payload-LESS push (just a wake-up), so there is nothing here to leak — no
// message text, no sender. The notification body is generic and the title is
// the user's own decoy label, both read from local state, never the push.
self.addEventListener('push', (event) => {
	event.waitUntil(
		(async () => {
			// The decoy label is stashed by the client in a cache entry the SW can
			// read (SW has no direct access to the app's IndexedDB keystore key,
			// and we never want message content here anyway).
			let title = 'New activity';
			try {
				const res = await caches.match('/__decoy_label');
				if (res) title = (await res.text()) || title;
			} catch {
				/* fall back to the generic title */
			}
			await self.registration.showNotification(title, {
				body: 'Open FlatFold to sync.',
				icon: '/icon-192.png',
				badge: '/badge-96.png', // monochrome status-bar badge (Android)
				tag: 'flatfold-sync', // collapse repeats
			});
		})()
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	event.waitUntil(
		self.clients.matchAll({ type: 'window' }).then((clients) => {
			const existing = clients.find((c) => 'focus' in c);
			if (existing) return existing.focus();
			return self.clients.openWindow('/chat');
		})
	);
});
