import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

// THE hard rule (docs/NATIVE_APPS_PLAN.md): the app ships the built web assets
// inside the signed binary and loads them locally (capacitor://localhost). It
// NEVER loads the app shell from a remote server.url — that's the whole security
// point (bundled + signed = reviewed-once code, which a browser can't promise).
// Only API + WebSocket traffic goes to the server, by absolute URL (lib/platform).
const config: CapacitorConfig = {
	appId: 'dev.flatfold', // registered App ID (ASC id ZVNWT69U94)
	appName: 'FlatFold',
	webDir: 'dist/client', // Cloudflare/Vite client output (index.html + assets/)
	plugins: {
		// `None`: the WKWebView does NOT resize for the keyboard. Instead the app
		// shrinks itself via a `--keyboard-height` CSS variable set from the
		// plugin's keyboardWillShow/WillHide events (which fire at the START of the
		// keyboard animation), with a CSS transition — so the docked composer
		// slides up in lockstep with the keyboard rather than a beat behind (the
		// lag `Native` mode had, where the frame reflowed at keyboardDidShow).
		// Because the app shrinks to sit above the keyboard, the WKWebView scroll
		// view has nothing below the fold to scroll, so the old "reveal the input"
		// drag can't return. (Chat.tsx wires the events + height.)
		Keyboard: {
			resize: KeyboardResize.None,
		},
	},
};

export default config;
