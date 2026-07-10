// Pre-paint theme seed. Must be an external file — CSP is `script-src
// 'self'` with no `unsafe-inline`.
//
// This mirrors exactly what src/hooks/useThemeInternal.ts computes on
// mount (localStorage['theme-preference'], defaulting to 'light' — no
// prefers-color-scheme fallback). Keeping the two in lockstep matters: if
// this seed guessed differently than the hook (e.g. by falling back to the
// OS preference), the very first React render could flip the `.dark` class
// back off, causing a visible flash in the opposite direction.
(function () {
	try {
		var stored = window.localStorage.getItem('theme-preference');
		var theme = stored === 'light' || stored === 'dark' ? stored : 'light';
		if (theme === 'dark') {
			document.documentElement.classList.add('dark');
		}
	} catch {
		// localStorage may be unavailable (private mode, disabled storage) —
		// fail safe to the light default already baked into the HTML.
	}
})();
