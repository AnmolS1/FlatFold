import { useState, useEffect, useCallback } from 'react';
import { type ThemeName, type ThemePreference, THEME_STORAGE_KEY, THEME_PREFERENCES, DARK_THEMES } from '../types/theme';

interface UseThemeReturn {
	preference: ThemePreference; // what the user chose (may be 'automatic')
	theme: ThemeName; // the resolved theme actually applied
	setPreference: (preference: ThemePreference) => void;
	toggleTheme: () => void; // quick light/dark flip for the header toggle
}

function prefersDark(): boolean {
	// jsdom (tests) has no matchMedia — treat as light.
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
	return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

// Automatic → Ink on a dark OS, Paper on a light one; otherwise the chosen theme.
function resolve(preference: ThemePreference): ThemeName {
	if (preference === 'automatic') return prefersDark() ? 'ink' : 'paper';
	return preference;
}

function readStoredPreference(): ThemePreference {
	const stored = localStorage.getItem(THEME_STORAGE_KEY);
	// Migrate the old binary values.
	if (stored === 'light') return 'paper';
	if (stored === 'dark') return 'ink';
	return THEME_PREFERENCES.includes(stored as ThemePreference) ? (stored as ThemePreference) : 'automatic';
}

export const useThemeInternal = (): UseThemeReturn => {
	const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
	const [theme, setThemeState] = useState<ThemeName>(() => resolve(preference));

	// Apply the resolved theme to <html data-theme>.
	useEffect(() => {
		const applied = resolve(preference);
		setThemeState(applied);
		document.documentElement.setAttribute('data-theme', applied);
	}, [preference]);

	// Follow live OS changes only while on Automatic.
	useEffect(() => {
		if (preference !== 'automatic' || typeof window.matchMedia !== 'function') return;
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		const onChange = () => {
			const applied = resolve('automatic');
			setThemeState(applied);
			document.documentElement.setAttribute('data-theme', applied);
		};
		mq.addEventListener('change', onChange);
		return () => mq.removeEventListener('change', onChange);
	}, [preference]);

	const setPreference = useCallback((next: ThemePreference) => {
		setPreferenceState(next);
		localStorage.setItem(THEME_STORAGE_KEY, next);
	}, []);

	// The header toggle: flip to the OTHER base theme, saved as an explicit choice.
	const toggleTheme = useCallback(() => {
		setPreferenceState((prev) => {
			const next: ThemePreference = DARK_THEMES.includes(resolve(prev)) ? 'paper' : 'ink';
			localStorage.setItem(THEME_STORAGE_KEY, next);
			return next;
		});
	}, []);

	return { preference, theme, setPreference, toggleTheme };
};
