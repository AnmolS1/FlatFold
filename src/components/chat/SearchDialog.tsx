import { useEffect, useMemo, useRef, useState } from 'react';
import MiniSearch from 'minisearch';
import { Search, X } from 'lucide-react';
import * as keystore from '../../keystore';
import { formatTimestamp } from '../../utils/formatTimestamp';

interface SearchDialogProps {
	username: string;
	onClose: () => void;
	onSelectResult: (contact: string) => void;
}

interface IndexedMessage {
	id: string;
	contact: string;
	from: string;
	text: string;
	ts: number;
}

// Local-only full-text search. The index is built IN MEMORY from decrypted
// history each time the dialog opens and is discarded on close — it is never
// written to IndexedDB (that would put plaintext at rest) and never leaves
// the device. Nothing here touches the network.
export const SearchDialog = ({ username, onClose, onSelectResult }: SearchDialogProps) => {
	const [query, setQuery] = useState('');
	const [results, setResults] = useState<IndexedMessage[]>([]);
	const [ready, setReady] = useState(false);
	const indexRef = useRef<MiniSearch<IndexedMessage> | null>(null);
	const docsRef = useRef<Map<string, IndexedMessage>>(new Map());
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			const all = await keystore.loadAllMessages(username);
			if (cancelled) return;
			const docs: IndexedMessage[] = all
				.filter(({ message }) => message.text.trim().length > 0)
				.map(({ contact, message }) => ({ id: message.id, contact, from: message.from, text: message.text, ts: message.ts }));

			const index = new MiniSearch<IndexedMessage>({
				fields: ['text'],
				storeFields: ['contact', 'from', 'text', 'ts'],
				searchOptions: { prefix: true, fuzzy: 0.2, boost: { text: 1 } },
			});
			index.addAll(docs);
			indexRef.current = index;
			docsRef.current = new Map(docs.map((d) => [d.id, d]));
			setReady(true);
			inputRef.current?.focus();
		})();
		return () => {
			cancelled = true;
			indexRef.current = null;
			docsRef.current = new Map();
		};
	}, [username]);

	useEffect(() => {
		const index = indexRef.current;
		if (!index || query.trim().length === 0) {
			setResults([]);
			return;
		}
		const hits = index.search(query).slice(0, 50);
		setResults(hits.map((h) => docsRef.current.get(h.id)).filter((m): m is IndexedMessage => m !== undefined));
	}, [query]);

	const placeholder = useMemo(() => (ready ? 'Search your messages…' : 'Indexing…'), [ready]);

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-20" onClick={onClose}>
			<div className="bg-graph-card border border-crease-line rounded-2xl max-w-lg w-full max-h-[70vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
				<div className="flex items-center gap-2 p-3 border-b border-crease-line">
					<Search className="w-5 h-5 text-graphite-40 flex-shrink-0" />
					<input
						ref={inputRef}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={placeholder}
						disabled={!ready}
						className="flex-1 bg-transparent text-graphite placeholder-graphite-40 outline-none disabled:opacity-50"
					/>
					<button onClick={onClose} aria-label="Close search" className="text-graphite-40 hover:text-graphite">
						<X className="w-5 h-5" />
					</button>
				</div>

				<div className="overflow-y-auto">
					{query.trim().length > 0 && results.length === 0 && ready && (
						<p className="text-sm text-graphite-40 p-4 text-center">No matches.</p>
					)}
					{results.map((r) => (
						<button
							key={r.id}
							onClick={() => onSelectResult(r.contact)}
							className="w-full text-left px-4 py-3 border-b border-crease-line hover:bg-inset transition-colors"
						>
							<div className="flex items-center justify-between mb-0.5">
								<span className="font-mono text-xs text-crease">{r.contact}</span>
								<span className="font-mono text-xs text-graphite-40">{formatTimestamp(r.ts)}</span>
							</div>
							<p className="text-sm text-graphite line-clamp-2">{r.text}</p>
						</button>
					))}
				</div>

				<p className="text-xs text-graphite-40 p-3 border-t border-crease-line font-mono">
					Searched entirely on this device — nothing sent to any server.
				</p>
			</div>
		</div>
	);
};
