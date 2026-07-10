import { createContext, useContext, type ReactNode } from 'react';
import { type Theme } from '../types/theme';
import { useThemeInternal } from '../hooks/useThemeInternal';

interface ThemeContextType {
	theme: Theme;
	setTheme: (theme: Theme) => void;
	toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

interface ThemeProviderProps {
	children: ReactNode;
}

export const ThemeProvider = ({ children }: ThemeProviderProps) => {
	const themeValue = useThemeInternal();

	return <ThemeContext.Provider value={themeValue}>{children}</ThemeContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components
export const useTheme = () => {
	const context = useContext(ThemeContext);
	if (context === undefined) {
		throw new Error('useTheme must be used within a ThemeProvider');
	}
	return context;
};
