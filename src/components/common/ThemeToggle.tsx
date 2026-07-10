import { memo } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';

const ThemeToggleComponent = () => {
	const { theme, toggleTheme } = useTheme();

	return (
		<button
			onClick={toggleTheme}
			className="p-2 rounded-lg border border-crease-line-bold bg-inset hover:border-crease transition-colors"
			aria-label="Toggle theme"
			type="button"
		>
			{theme === 'light' ? (
				<Moon className="w-5 h-5 text-graphite-60" />
			) : (
				<Sun className="w-5 h-5 text-graphite-60" />
			)}
		</button>
	);
};

export const ThemeToggle = memo(ThemeToggleComponent);
