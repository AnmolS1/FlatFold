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
export default defineConfig({
	test: {
		projects: [
			{
				plugins: [
					cloudflareTest({
						main: './worker/index.ts',
						wrangler: { configPath: './wrangler.jsonc' },
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
