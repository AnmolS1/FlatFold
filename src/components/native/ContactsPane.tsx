import { memo, useCallback, useMemo, useState, type FormEvent } from 'react';
import { UserPlus, ShieldCheck, ShieldAlert, Ban, Trash2, Search } from 'lucide-react';
import type { ContactRecord } from '../../keystore';
import { Avatar } from '../common/Avatar';
import { isBlocked } from '../../lib/blocklist';

// The Contacts tab (native shell): the address book, distinct from the Chats
// list. Add someone by exact username, see verification state, open a chat,
// verify, block/unblock, or remove a contact. Verification/QR itself lives in
// the chat's contact sheet (SafetyNumberDialog) — the "Verify" affordance here
// jumps into that flow.
//
// Presentational pane: every action is a callback wired in Chat.tsx to the
// existing (crypto-owning) handlers — nothing here touches the keystore.

interface ContactsPaneProps {
	contacts: ContactRecord[];
	currentUsername: string;
	/** Bumps when the block list changes, to re-derive blocked state. */
	blockVersion?: number;
	onAddContact: (username: string) => Promise<void>;
	onOpenChat: (username: string) => void;
	onVerify: (username: string) => void;
	onRemove: (username: string) => void;
	onBlock: (username: string) => void;
	onUnblock: (username: string) => void;
}

const ContactsPaneComponent = ({
	contacts,
	currentUsername,
	blockVersion,
	onAddContact,
	onOpenChat,
	onVerify,
	onRemove,
	onBlock,
	onUnblock,
}: ContactsPaneProps) => {
	const [input, setInput] = useState('');
	const [adding, setAdding] = useState(false);
	const [query, setQuery] = useState('');

	const handleAdd = useCallback(
		async (e: FormEvent<HTMLFormElement>) => {
			e.preventDefault();
			const username = input.trim();
			if (!username) return;
			setAdding(true);
			try {
				await onAddContact(username);
				setInput('');
			} finally {
				setAdding(false);
			}
		},
		[input, onAddContact]
	);

	const rows = useMemo(() => {
		const q = query.trim().toLowerCase();
		const list = q ? contacts.filter((c) => c.username.toLowerCase().includes(q)) : contacts;
		return [...list].sort((a, b) => a.username.localeCompare(b.username));
	}, [contacts, query]);

	// Re-derived when blockVersion bumps (block state lives in localStorage, so
	// the `void blockVersion` reference makes it a real dependency).
	const blockedSet = useMemo(() => {
		void blockVersion;
		return new Set(contacts.filter((c) => isBlocked(currentUsername, c.username)).map((c) => c.username));
	}, [contacts, currentUsername, blockVersion]);

	return (
		<div className="w-full min-h-0 flex flex-col bg-graph-card">
			{/* Add by exact username — the only way to add a contact (no directory,
			    no phone/email lookup); that privacy property is a selling point. */}
			<div className="flex-shrink-0 p-3 border-b border-crease-line space-y-3">
				<form onSubmit={handleAdd} className="flex gap-2">
					<input
						value={input}
						onChange={(e) => setInput(e.target.value)}
						placeholder="Add someone by username"
						aria-label="Add someone by exact username"
						disabled={adding}
						autoCapitalize="none"
						autoCorrect="off"
						className="flex-1 min-w-0 rounded-full border border-crease-line-bold bg-inset text-graphite placeholder-graphite-40 px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-crease focus:border-transparent disabled:opacity-50"
					/>
					<button
						type="submit"
						disabled={adding || !input.trim()}
						className="flex-shrink-0 bg-crane text-white w-11 h-11 flex items-center justify-center rounded-full hover:bg-crane-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
						aria-label="Add contact"
					>
						<UserPlus className="w-5 h-5" />
					</button>
				</form>
				{contacts.length > 4 && (
					<div className="relative">
						<Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-graphite-40 pointer-events-none" />
						<input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Filter contacts"
							aria-label="Filter contacts"
							className="w-full rounded-full border border-crease-line-bold bg-inset text-graphite placeholder-graphite-40 pl-9 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-crease focus:border-transparent"
						/>
					</div>
				)}
			</div>

			<div className="flex-1 overflow-y-auto overscroll-contain">
				{contacts.length === 0 ? (
					<div className="flex flex-col items-center justify-center text-center px-6 py-12 h-full">
						<UserPlus className="w-10 h-10 text-graphite-40 mb-3" aria-hidden="true" />
						<h3 className="font-display text-base font-semibold text-graphite mb-1">No contacts yet</h3>
						<p className="text-sm text-graphite-60">Add someone by their username to start a conversation.</p>
					</div>
				) : rows.length === 0 ? (
					<p className="text-sm text-graphite-40 p-6 text-center">No contacts match &ldquo;{query}&rdquo;.</p>
				) : (
					rows.map((c) => {
						const blocked = blockedSet.has(c.username);
						return (
							<div
								key={c.username}
								className={`w-full flex items-center gap-3 px-4 min-h-[64px] py-2 border-b border-crease-line ${blocked ? 'opacity-60' : ''}`}
							>
								<button
									onClick={() => !blocked && onOpenChat(c.username)}
									disabled={blocked}
									className="flex items-center gap-3 flex-1 min-w-0 text-left disabled:cursor-default"
									aria-label={blocked ? c.username : `Open chat with ${c.username}`}
								>
									<Avatar name={c.username} size={40} />
									<span className="flex-1 min-w-0">
										<span className="block truncate text-graphite font-medium lowercase">{c.username}</span>
										<span className="flex items-center gap-1 text-xs font-mono mt-0.5">
											{blocked ? (
												<span className="flex items-center gap-1 text-crane-ink">
													<Ban className="w-3.5 h-3.5" /> blocked
												</span>
											) : c.keyChangeUnacknowledged ? (
												<span className="flex items-center gap-1 text-crane-ink">
													<ShieldAlert className="w-3.5 h-3.5" /> safety number changed
												</span>
											) : c.verified ? (
												<span className="flex items-center gap-1 text-sax-ink">
													<ShieldCheck className="w-3.5 h-3.5" /> verified
												</span>
											) : (
												<span className="text-graphite-40">not verified</span>
											)}
										</span>
									</span>
								</button>
								{blocked ? (
									<button
										onClick={() => onUnblock(c.username)}
										className="flex-shrink-0 min-h-11 px-3 flex items-center justify-center rounded-lg border border-crease-line-bold text-sm text-graphite hover:border-crease transition-colors"
									>
										Unblock
									</button>
								) : (
									<>
										<button
											onClick={() => onVerify(c.username)}
											aria-label={`Verify ${c.username}`}
											title="Safety number"
											className="flex-shrink-0 w-11 h-11 flex items-center justify-center rounded-lg text-graphite hover:text-crease transition-colors"
										>
											<ShieldCheck className="w-5 h-5" />
										</button>
										<button
											onClick={() => onBlock(c.username)}
											aria-label={`Block ${c.username}`}
											title="Block"
											className="flex-shrink-0 w-11 h-11 flex items-center justify-center rounded-lg text-graphite hover:text-crane-ink transition-colors"
										>
											<Ban className="w-5 h-5" />
										</button>
										<button
											onClick={() => onRemove(c.username)}
											aria-label={`Remove ${c.username}`}
											title="Remove contact"
											className="flex-shrink-0 w-11 h-11 flex items-center justify-center rounded-lg text-crane-ink hover:opacity-70 transition-opacity"
										>
											<Trash2 className="w-5 h-5" />
										</button>
									</>
								)}
							</div>
						);
					})
				)}
			</div>
		</div>
	);
};

export const ContactsPane = memo(ContactsPaneComponent);
