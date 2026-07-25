import { memo } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { DARK_THEMES } from '../../types/theme';

const ThemeToggleComponent = () => {
	const { theme, toggleTheme } = useTheme();
	const isDark = DARK_THEMES.includes(theme);

	return (
		<button
			onClick={toggleTheme}
			className="p-2 rounded-lg border border-crease-line-bold bg-inset hover:border-crease transition-colors"
			aria-label="Toggle light or dark theme"
			type="button"
		>
			{isDark ? <Sun className="w-5 h-5 text-graphite-60" /> : <Moon className="w-5 h-5 text-graphite-60" />}
		</button>
	);
};

export const ThemeToggle = memo(ThemeToggleComponent);
