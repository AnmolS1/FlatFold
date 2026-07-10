import { useState, useEffect, useCallback } from 'react';
import { type Theme, THEME_STORAGE_KEY } from '../types/theme';

interface UseThemeReturn {
	theme: Theme;
	setTheme: (theme: Theme) => void;
	toggleTheme: () => void;
}

export const useThemeInternal = (): UseThemeReturn => {
	const [theme, setThemeState] = useState<Theme>(() => {
		// Read from localStorage on initial load
		const stored = localStorage.getItem(THEME_STORAGE_KEY);
		return (stored === 'light' || stored === 'dark') ? stored : 'light';
	});

	// Apply theme to document element
	useEffect(() => {
		const root = document.documentElement;

		if (theme === 'dark') {
			root.classList.add('dark');
		} else {
			root.classList.remove('dark');
		}
	}, [theme]);

	// Set theme with localStorage persistence
	const setTheme = useCallback((newTheme: Theme) => {
		setThemeState(newTheme);
		localStorage.setItem(THEME_STORAGE_KEY, newTheme);
	}, []);

	// Toggle between light and dark
	const toggleTheme = useCallback(() => {
		setThemeState((prevTheme) => {
			const newTheme = prevTheme === 'light' ? 'dark' : 'light';
			localStorage.setItem(THEME_STORAGE_KEY, newTheme);
			return newTheme;
		});
	}, []);

	return {
		theme,
		setTheme,
		toggleTheme,
	};
};
