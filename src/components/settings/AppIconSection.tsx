import { useState, useEffect, useCallback } from 'react';
import { AppWindow, Check } from 'lucide-react';
import { appIconSupported, getAppIcon, setAppIcon, type AppIconName } from '../../lib/appIcon';

// Each option's [ground, border, fold] preview colors, matching the generated
// alternate icons (ios/App/App/AltIcons). 'default' shows the Paper look (it
// auto-switches light/dark on device).
const OPTIONS: { name: AppIconName; label: string; colors: [string, string, string] }[] = [
	{ name: 'default', label: 'Default', colors: ['#EEF0EC', '#2E5E8C', '#E84A27'] },
	{ name: 'Vellum', label: 'Vellum', colors: ['#EFE7D6', '#8A4B2A', '#B23A1B'] },
	{ name: 'Graphite', label: 'Graphite', colors: ['#FBFBFA', '#16181A', '#C23A1C'] },
	{ name: 'Midnight', label: 'Midnight', colors: ['#14110E', '#F08A5D', '#F08A5D'] },
];

// D3 extra — manual app-icon picker (native only; self-hides where alternate
// icons aren't supported). iOS confirms every change with a system alert, so this
// is deliberately not tied to the live theme.
export function AppIconSection() {
	const [supported, setSupported] = useState(false);
	const [current, setCurrent] = useState<AppIconName>('default');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const ok = await appIconSupported();
			if (cancelled) return;
			setSupported(ok);
			if (ok) setCurrent(await getAppIcon());
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const choose = useCallback(async (name: AppIconName) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await setAppIcon(name); // iOS shows its confirmation alert here
			setCurrent(name);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Could not change the app icon.');
		} finally {
			setBusy(false);
		}
	}, [busy]);

	if (!supported) return null;

	return (
		<section className="mb-6">
			<h3 className="text-sm font-semibold text-graphite mb-2 flex items-center gap-2">
				<AppWindow className="w-4 h-4" /> App icon
			</h3>
			<div className="grid grid-cols-2 gap-2">
				{OPTIONS.map((o) => {
					const selected = current === o.name;
					return (
						<button
							key={o.name}
							onClick={() => void choose(o.name)}
							disabled={busy}
							className={`flex items-center gap-2 rounded-lg border p-2 text-sm transition-colors disabled:opacity-50 ${
								selected ? 'border-crease bg-crease/10' : 'border-crease-line-bold hover:border-crease'
							}`}
							aria-pressed={selected}
						>
							<span
								className="flex-shrink-0 rounded-[7px] border border-crease-line flex items-center justify-center"
								style={{ width: 28, height: 28, background: o.colors[0] }}
							>
								<span style={{ width: 12, height: 12, border: `2px solid ${o.colors[1]}`, borderRadius: 2, position: 'relative' }}>
									<span style={{ position: 'absolute', top: -2, right: -2, width: 5, height: 5, background: o.colors[2] }} />
								</span>
							</span>
							<span className="flex-1 text-left text-graphite truncate">{o.label}</span>
							{selected && <Check className="w-4 h-4 text-crease flex-shrink-0" />}
						</button>
					);
				})}
			</div>
			<p className="text-xs text-graphite-40 mt-2">iOS will ask you to confirm each change.</p>
			{error && <p className="text-xs text-crane mt-1">{error}</p>}
		</section>
	);
}
