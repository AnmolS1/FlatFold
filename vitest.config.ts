import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
	plugins: [
		cloudflareTest({
			main: './worker/index.ts',
			wrangler: { configPath: './wrangler.jsonc' },
		}),
	],
	test: {
		setupFiles: ['./test/setup.ts'],
	},
});
