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
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
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
