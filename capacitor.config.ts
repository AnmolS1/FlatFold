import type { CapacitorConfig } from '@capacitor/cli';

// THE hard rule (docs/NATIVE_APPS_PLAN.md): the app ships the built web assets
// inside the signed binary and loads them locally (capacitor://localhost). It
// NEVER loads the app shell from a remote server.url — that's the whole security
// point (bundled + signed = reviewed-once code, which a browser can't promise).
// Only API + WebSocket traffic goes to the server, by absolute URL (lib/platform).
const config: CapacitorConfig = {
	appId: 'dev.flatfold', // registered App ID (ASC id ZVNWT69U94)
	appName: 'FlatFold',
	webDir: 'dist/client', // Cloudflare/Vite client output (index.html + assets/)
};

export default config;
