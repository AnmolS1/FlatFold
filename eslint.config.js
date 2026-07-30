import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
	// 'build' is fastlane's export directory. It holds an unpacked App.app, and
	// linting Capacitor's vendored native-bridge.js inside it reported an error
	// from a framework resource — for a rule this config does not even define.
	globalIgnores(['dist', 'ios', 'build', 'worker-configuration.d.ts', '.remember', '.wrangler']),
	{
		files: ['**/*.{ts,tsx}'],
		extends: [
			js.configs.recommended,
			tseslint.configs.recommended,
			reactHooks.configs['recommended-latest'],
			reactRefresh.configs.vite,
		],
		languageOptions: {
			ecmaVersion: 2020,
			globals: globals.browser,
		},
	},
])
