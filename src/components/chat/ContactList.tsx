import { memo, useCallback, useMemo, useState, type FormEvent } from 'react';
import { ShieldAlert, ShieldCheck, UserPlus, Users, Plus, Search, Clock, X } from 'lucide-react';
import type { ContactRecord, GroupRecord, ConversationSummary } from '../../keystore';
import { groupConversationKey } from '../../lib/messaging';
import { isUnread, previewLabel } from '../../lib/conversationSummary';
import { isBlocked } from '../../lib/blocklist';
import { formatListTimestamp } from '../../utils/formatTimestamp';
import { Avatar } from '../common/Avatar';
import { EmptyStateIllustration } from '../common/Brand';

interface ContactListProps {
	contacts: ContactRecord[];
	groups: GroupRecord[];
	summaries: Record<string, ConversationSummary>;
	currentUsername: string;
	activeContact: string | null;
	activeGroupId: string | null;
	onSelectContact: (username: string) => void;
	onSelectGroup: (group: GroupRecord) => void;
	onAddContact: (username: string) => Promise<void>;
	onNewGroup: () => void;
	/** Notifies the shell when the compose bar opens/closes, so it can hide the
	    tab bar — keeping the add-username input the bottom-most element above the
	    keyboard (otherwise iOS scroll-to-reveal drags the list under the bar). */
	onComposeOpenChange?: (open: boolean) => void;
	/** Bumps when the block list changes, to re-run the (blocked-filtered) rows. */
	blockVersion?: number;
}

// A single normalized conversation row, whether it's a 1:1 or a group.
interface Row {
	key: string; // convoKey: contact username, or groupConversationKey(group.id)
	name: string;
	isGroup: boolean;
	group?: GroupRecord;
	contact?: ContactRecord;
	summary?: ConversationSummary;
}

function disappearingLabel(seconds: number): string {
	if (seconds >= 604800) return `${Math.round(seconds / 604800)}w`;
	if (seconds >= 86400) return `${Math.round(seconds / 86400)}d`;
	if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`;
	return `${Math.round(seconds / 60)}m`;
}

const ContactListComponent = ({
	contacts,
	groups,
	summaries,
	currentUsername,
	activeContact,
	activeGroupId,
	onSelectContact,
	onSelectGroup,
	onAddContact,
	onNewGroup,
	onComposeOpenChange,
	blockVersion,
}: ContactListProps) => {
	const [query, setQuery] = useState('');
	const [newChatOpen, setNewChatOpen] = useState(false);
	const [input, setInput] = useState('');
	const [adding, setAdding] = useState(false);

	// Toggle compose + tell the shell (so it can hide the tab bar) in one place.
	const setCompose = useCallback(
		(open: boolean) => {
			setNewChatOpen(open);
			onComposeOpenChange?.(open);
		},
		[onComposeOpenChange]
	);

	const handleSubmit = useCallback(
		async (e: FormEvent<HTMLFormElement>) => {
			e.preventDefault();
			const username = input.trim();
			if (!username) return;

			setAdding(true);
			try {
				await onAddContact(username);
				setInput('');
				setCompose(false);
			} finally {
				setAdding(false);
			}
		},
		[input, onAddContact, setCompose]
	);

	// Unified, activity-sorted conversation list (groups + contacts together),
	// then filtered by the local search box.
	const rows = useMemo<Row[]>(() => {
		void blockVersion; // re-run the blocked filter when the block list changes
		const all: Row[] = [
			...groups.map((group) => ({
				key: groupConversationKey(group.id),
				name: group.name,
				isGroup: true,
				group,
				summary: summaries[groupConversationKey(group.id)],
			})),
			...contacts.map((contact) => ({
				key: contact.username,
				name: contact.username,
				isGroup: false,
				contact,
				summary: summaries[contact.username],
			})),
		];
		// Hide blocked contacts' conversations (groups are unaffected).
		const visible = all.filter((r) => r.isGroup || !isBlocked(currentUsername, r.key));
		const q = query.trim().toLowerCase();
		const filtered = q ? visible.filter((r) => r.name.toLowerCase().includes(q)) : visible;
		// Most-recent conversation first; those with no activity fall to the
		// bottom, ordered by name.
		return filtered.sort((a, b) => {
			const at = a.summary?.lastTs ?? 0;
			const bt = b.summary?.lastTs ?? 0;
			if (at !== bt) return bt - at;
			return a.name.localeCompare(b.name);
		});
	}, [contacts, groups, summaries, query, currentUsername, blockVersion]);

	const renderPreview = (row: Row): { text: string; muted: boolean } => {
		if (row.summary) return { text: previewLabel(row.summary, currentUsername), muted: false };
		// No preview yet — surface the disappearing-timer state in the snippet
		// slot if one is set, else a quiet placeholder.
		if (!row.isGroup && row.contact?.disappearingSeconds) {
			return { text: `Disappearing · ${disappearingLabel(row.contact.disappearingSeconds)}`, muted: true };
		}
		return { text: 'No messages yet', muted: true };
	};

	const isEmpty = contacts.length === 0 && groups.length === 0;

	return (
		<div className="w-full min-h-0 min-[900px]:border-r border-crease-line flex flex-col bg-graph-card relative">
			{/* Local search — filters this list only; never touches the network. */}
			<div className="p-3 border-b border-crease-line">
				<div className="relative">
					<Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-graphite-40 pointer-events-none" />
					{/* 16px floor (D2 §0.1): no text-sm on an input — sub-16px focus
					    auto-zooms iOS Safari. Native additionally locks the viewport. */}
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search locally"
						aria-label="Search conversations locally"
						className="w-full rounded-full border border-crease-line-bold bg-inset text-graphite placeholder-graphite-40 pl-9 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-crease focus:border-transparent"
					/>
				</div>
			</div>

			<div className="flex-1 overflow-y-auto overscroll-contain">
				{isEmpty ? (
					<div className="flex flex-col items-center justify-center text-center px-6 py-12 h-full">
						<EmptyStateIllustration className="w-40 mb-4" />
						<h3 className="font-display text-base font-semibold text-graphite mb-1">No conversations yet</h3>
						<p className="text-sm text-graphite-60">Tap the orange button to start one.</p>
					</div>
				) : rows.length === 0 ? (
					<p className="text-sm text-graphite-40 p-6 text-center">No matches for &ldquo;{query}&rdquo;.</p>
				) : (
					rows.map((row) => {
						const active = row.isGroup ? row.group?.id === activeGroupId : row.key === activeContact;
						const unread = isUnread(row.summary, currentUsername);
						const preview = renderPreview(row);
						return (
							<button
								key={row.key}
								onClick={() => (row.isGroup ? onSelectGroup(row.group!) : onSelectContact(row.key))}
								className={`w-full text-left flex items-center gap-3 px-4 min-h-[60px] py-2 border-b border-crease-line transition-colors relative ${
									active ? 'bg-crease/10 border-l-2 border-l-crane pl-[14px]' : 'hover:bg-inset'
								}`}
							>
								<Avatar name={row.name} group={row.isGroup} size={40} />
								<div className="flex-1 min-w-0">
									<div className="flex items-baseline justify-between gap-2">
										<span className="truncate text-graphite font-medium lowercase">{row.name}</span>
										{row.summary && (
											<span className="flex-shrink-0 font-mono text-xs text-graphite-40">
												{formatListTimestamp(row.summary.lastTs)}
											</span>
										)}
									</div>
									<div className="flex items-center justify-between gap-2 mt-0.5">
										<span className={`truncate text-sm flex items-center gap-1 ${preview.muted ? 'text-graphite-40' : 'text-graphite-60'}`}>
											{preview.muted && !row.summary && !row.isGroup && row.contact?.disappearingSeconds ? (
												<Clock className="w-3 h-3 flex-shrink-0" />
											) : null}
											<span className="truncate">{preview.text}</span>
										</span>
										<span className="flex items-center gap-1.5 flex-shrink-0">
											{!row.isGroup && row.contact?.keyChangeUnacknowledged ? (
												<ShieldAlert className="w-4 h-4 text-crane" aria-label="Safety number changed" />
											) : !row.isGroup && row.contact?.verified ? (
												<ShieldCheck className="w-4 h-4 text-sax" aria-label="Verified" />
											) : null}
											{row.isGroup && <Users className="w-3.5 h-3.5 text-graphite-40" aria-hidden="true" />}
											{unread && <span className="w-2 h-2 rounded-full bg-crane" aria-label="Unread" />}
										</span>
									</div>
								</div>
							</button>
						);
					})
				)}
			</div>

			{/* Compose — no floating FAB (D2 §2). Closed: a docked "New message"
			    button, with the tab bar beneath it. Open: the add-username input
			    becomes the BOTTOM-MOST element (New group sits above it) and the
			    shell hides the tab bar, so the input docks directly above the
			    keyboard — iOS never has to scroll-to-reveal it and drag the list. */}
			{newChatOpen ? (
				<>
					<div className="flex-shrink-0 border-t border-crease-line bg-inset px-3 py-2">
						<button
							onClick={() => {
								setCompose(false);
								onNewGroup();
							}}
							className="w-full flex items-center justify-center gap-2 min-h-11 px-3 rounded-lg border border-crease-line-bold text-graphite hover:border-crease transition-colors"
						>
							<Users className="w-4 h-4" /> New group
						</button>
					</div>
					<form
						onSubmit={handleSubmit}
						className="flex-shrink-0 flex items-center gap-2 border-t border-crease-line bg-graph-card px-3 py-2.5 env-safe-bottom env-safe-x"
					>
						<button
							type="button"
							onClick={() => setCompose(false)}
							aria-label="Cancel new message"
							className="h-11 w-11 flex-shrink-0 flex items-center justify-center rounded-full border border-crease-line-bold text-graphite hover:border-crease transition-colors"
						>
							<X className="w-5 h-5" />
						</button>
						<input
							value={input}
							onChange={(e) => setInput(e.target.value)}
							placeholder="Add someone by username"
							aria-label="Add someone by username"
							disabled={adding}
							autoFocus
							autoCapitalize="none"
							autoCorrect="off"
							className="flex-1 min-w-0 rounded-full border border-crease-line-bold bg-inset text-graphite placeholder-graphite-40 px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-crease focus:border-transparent disabled:opacity-50"
						/>
						<button
							type="submit"
							disabled={adding || !input.trim()}
							className="flex-shrink-0 bg-crane text-white w-11 h-11 flex items-center justify-center rounded-full hover:bg-crane-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
							aria-label="Start conversation"
						>
							<UserPlus className="w-5 h-5" />
						</button>
					</form>
				</>
			) : (
				<div className="flex-shrink-0 border-t border-crease-line bg-graph-card px-3 py-2.5 env-safe-x">
					<button
						onClick={() => setCompose(true)}
						aria-label="New message"
						aria-expanded={false}
						className="w-full min-h-11 flex items-center justify-center gap-2 rounded-full bg-crane text-white font-medium hover:bg-crane-dark transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-crane focus-visible:ring-offset-2"
					>
						<Plus className="w-5 h-5" /> New message
					</button>
				</div>
			)}
		</div>
	);
};

export const ContactList = memo(ContactListComponent);
