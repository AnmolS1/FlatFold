// The five themes (D3) plus the "Automatic" preference that follows the OS.
export type ThemeName = 'paper' | 'ink' | 'vellum' | 'graphite' | 'midnight-crane';
export type ThemePreference = 'automatic' | ThemeName;

export const THEME_STORAGE_KEY = 'theme-preference' as const;

export const THEME_PREFERENCES: ThemePreference[] = ['automatic', 'paper', 'ink', 'vellum', 'graphite', 'midnight-crane'];

// The two dark themes — used to resolve Automatic against the OS and to pick the
// light/dark icon in the quick toggle.
export const DARK_THEMES: ThemeName[] = ['ink', 'midnight-crane'];

export const THEME_LABELS: Record<ThemePreference, string> = {
	automatic: 'Automatic',
	paper: 'Paper',
	ink: 'Ink',
	vellum: 'Vellum',
	graphite: 'Graphite',
	'midnight-crane': 'Midnight Crane',
};
