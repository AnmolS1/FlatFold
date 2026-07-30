import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

// Register the service worker in PRODUCTION ONLY. Under `vite dev` a cache-first
// SW fights Vite's unbundled-module HMR (stale modules, broken reloads), so the
// PWA is only wired up in built output — verify it via `vite preview`, not dev.
// `__flatfoldNoSW` is a DEBUG-only escape injected natively (MainViewController,
// `--no-sw`) so a build can run with the service worker provably absent. It
// exists to test whether the SW is what stops late media loads on Mac — the SW
// re-registers on every launch, so unregistering it at runtime is not enough to
// answer that question.
const swDisabled = (window as unknown as { __flatfoldNoSW?: boolean }).__flatfoldNoSW === true;
if (import.meta.env.PROD && 'serviceWorker' in navigator && !swDisabled) {
	window.addEventListener('load', () => {
		navigator.serviceWorker.register('/sw.js').catch((err) => console.error('SW registration failed:', err));
	});
	// The SW posts flatfold:integrity-mismatch when a pinned shell asset's bytes
	// don't match the build manifest (H1). Bridge it to a window event the app
	// surfaces as a visible warning (same shape as the seal-keypin mismatch).
	navigator.serviceWorker.addEventListener('message', (e) => {
		if (e.data?.type === 'flatfold:integrity-mismatch') {
			console.error('[sw] app-shell integrity mismatch:', e.data.path);
			window.dispatchEvent(new CustomEvent('flatfold:integrity-mismatch'));
		}
	});
}
