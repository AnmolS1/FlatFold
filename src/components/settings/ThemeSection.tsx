import { Palette, Monitor, Check } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { THEME_PREFERENCES, THEME_LABELS, type ThemePreference } from '../../types/theme';

// A tiny [page, structural, accent] swatch per theme so the picker previews each
// look. Automatic shows a monitor icon (it follows the OS). D3 §4.
const SWATCH: Record<Exclude<ThemePreference, 'automatic'>, [string, string, string]> = {
	paper: ['#EEF0EC', '#2E5E8C', '#E84A27'],
	ink: ['#0E1A24', '#82A9CE', '#E84A27'],
	vellum: ['#EFE7D6', '#8A4B2A', '#B23A1B'],
	graphite: ['#FBFBFA', '#2E5E8C', '#C23A1C'],
	'midnight-crane': ['#14110E', '#F08A5D', '#E84A27'],
};

export function ThemeSection() {
	const { preference, setPreference } = useTheme();

	return (
		<section className="mb-6">
			<h3 className="text-sm font-semibold text-graphite mb-2 flex items-center gap-2">
				<Palette className="w-4 h-4" /> Appearance
			</h3>
			<div className="grid grid-cols-2 gap-2">
				{THEME_PREFERENCES.map((p) => {
					const selected = preference === p;
					return (
						<button
							key={p}
							onClick={() => setPreference(p)}
							className={`flex items-center gap-2 rounded-lg border p-2 text-sm transition-colors ${
								selected ? 'border-crease bg-crease/10' : 'border-crease-line-bold hover:border-crease'
							}`}
							aria-pressed={selected}
						>
							{p === 'automatic' ? (
								<Monitor className="w-5 h-5 text-graphite-60 flex-shrink-0" />
							) : (
								<span className="flex-shrink-0 flex rounded overflow-hidden border border-crease-line" style={{ width: 28, height: 20 }}>
									{SWATCH[p].map((c, i) => (
										<span key={i} style={{ background: c, width: 28 / 3, height: 20 }} />
									))}
								</span>
							)}
							<span className="flex-1 text-left text-graphite truncate">{THEME_LABELS[p]}</span>
							{selected && <Check className="w-4 h-4 text-crease flex-shrink-0" />}
						</button>
					);
				})}
			</div>
		</section>
	);
}
