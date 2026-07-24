import { memo } from 'react';
import { MessagesSquare, Users, Settings2 } from 'lucide-react';
import { haptic } from '../../lib/haptics';

// The native bottom tab bar (Direction C): Chats / Contacts / Settings. Shown
// only in the native shell — the web build keeps its ≥900px master/detail
// sidebar untouched (Chat.tsx gates this on isNativePlatform()). It sits in
// normal flow at the bottom of the list surface, padded by the home-indicator
// safe area, so it is NEVER a floating element fighting the viewport.
//
// Accessibility: a real <nav> with role tabs, 44pt targets, an aria-current on
// the active tab, and text labels beneath each glyph (icon-only tab bars fail
// VoiceOver users and low-vision users who don't recognise the glyph).

export type NativeTab = 'chats' | 'contacts' | 'settings';

interface TabDef {
	id: NativeTab;
	label: string;
	Icon: typeof MessagesSquare;
}

const TABS: TabDef[] = [
	{ id: 'chats', label: 'Chats', Icon: MessagesSquare },
	{ id: 'contacts', label: 'Contacts', Icon: Users },
	{ id: 'settings', label: 'Settings', Icon: Settings2 },
];

interface TabBarProps {
	active: NativeTab;
	onChange: (tab: NativeTab) => void;
	/** Unread badge on the Chats tab. */
	chatsUnread?: boolean;
}

const TabBarComponent = ({ active, onChange, chatsUnread = false }: TabBarProps) => {
	return (
		<nav
			aria-label="Primary"
			role="tablist"
			className="flex-shrink-0 flex items-stretch bg-graph-card border-t border-crease-line env-safe-bottom env-safe-x"
		>
			{TABS.map(({ id, label, Icon }) => {
				const selected = active === id;
				return (
					<button
						key={id}
						type="button"
						role="tab"
						aria-selected={selected}
						aria-current={selected ? 'page' : undefined}
						onClick={() => {
							if (!selected) haptic();
							onChange(id);
						}}
						className={`relative flex-1 min-h-[52px] flex flex-col items-center justify-center gap-0.5 pt-1.5 pb-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-crease ${
							selected ? 'text-crease' : 'text-graphite-40 hover:text-graphite-60'
						}`}
					>
						<span className="relative">
							<Icon className="w-6 h-6" strokeWidth={selected ? 2.4 : 2} aria-hidden="true" />
							{id === 'chats' && chatsUnread && (
								<span
									className="absolute -top-0.5 -right-1 w-2 h-2 rounded-full bg-crane ring-2 ring-graph-card"
									aria-label="Unread messages"
								/>
							)}
						</span>
						<span className="text-[11px] font-medium leading-none tracking-tight">{label}</span>
					</button>
				);
			})}
		</nav>
	);
};

export const TabBar = memo(TabBarComponent);
