import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import react from '@vitejs/plugin-react';

// Two projects, because the suite spans two runtimes:
//
// - `worker` runs everything in test/ inside the real Workers runtime (DOs, D1,
//   the actual fetch handler). That's the bulk of the suite and is unchanged.
//   It has no DOM, so it can only import leaf modules from src/ — anything
//   reaching keystore/storage.ts (IndexedDB) or lib/api.ts (DOM fetch) won't
//   typecheck against the worker types.
// - `ui` runs component tests in test-ui/ under jsdom, for behavior that is
//   only observable in a DOM (focus, and so the mobile keyboard staying up).
//
// test-ui/ deliberately sits outside src/ so component tests never land in the
// app build path or the Vite bundle.
// Throwaway keys so the suite is HERMETIC — a fresh clone (and CI) can run
// `npm test` with no secrets. Before this, the worker tests silently depended on
// the gitignored `.dev.vars`, and without it every auth, push and sealed-sender
// test failed.
//
// These are generated test-only keypairs, matched public-to-private so the
// HPKE and VAPID round trips actually work. They are NOT the production values
// — prod's live in `wrangler secret put` and are never in the repo. Publishing
// these is harmless precisely because they protect nothing; treat any of them
// appearing in a deployed environment as a bug.
const TEST_SECRETS = {
	SESSION_SECRET: 'test-session-secret-not-used-in-production',
	// Empty = relay-auth enforcement OFF, which is the default the gateway tests
	// assume; they set it per-case to exercise the enforced path.
	SEAL_RELAY_AUTH: '',
	SEAL_GATEWAY_PUBLIC_KEY: 'BKD6BWPwEX5CT3gBOtJskYZClaLEmxkN3eRXdpptg7SuSOQXcJx6k+1zyYLLax1b+wR1MXnyj9SZNU//EcaLV1E=',
	SEAL_GATEWAY_PRIVATE_KEY: '8hhNfXY3rYb6CipeLD1/8FKxksxn0H03tNgwLxMM7bw=',
	VAPID_PUBLIC_KEY: 'BMH4MED-srfuzg_r2p_mnItRUg8vETmzHkExC3zxyWX0iccTyKJSYzKkx1ys6L5eJJCZSbkBSwTtiOo8HNwvnf8',
	VAPID_SUBJECT: 'mailto:test@example.invalid',
	VAPID_PRIVATE_JWK:
		'{"key_ops":["sign"],"ext":true,"kty":"EC","x":"wfgwQP6yt-7OD-van-aci1FSDy8RObMeQTELfPHJZfQ","y":"iccTyKJSYzKkx1ys6L5eJJCZSbkBSwTtiOo8HNwvnf8","crv":"P-256","d":"ofZV_ukxheMIyubigR3iQ85IUvvIe1H6_tyTjKEqrsE"}',
};

export default defineConfig({
	test: {
		projects: [
			{
				plugins: [
					cloudflareTest({
						main: './worker/index.ts',
						wrangler: { configPath: './wrangler.jsonc' },
						miniflare: { bindings: TEST_SECRETS },
					}),
				],
				test: {
					name: 'worker',
					// Both homes: worker/DO integration tests in test/, and the
					// co-located unit tests next to the pure modules in src/.
					include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
					setupFiles: ['./test/setup.ts'],
				},
			},
			{
				plugins: [react()],
				test: {
					name: 'ui',
					// .tsx for components, .ts for anything else needing browser APIs
					// the workers pool doesn't have — notably IndexedDB, which the
					// keystore is built on (backed by fake-indexeddb in setup).
					include: ['test-ui/**/*.test.{ts,tsx}'],
					environment: 'jsdom',
					setupFiles: ['./test-ui/setup.ts'],
				},
			},
		],
	},
});
