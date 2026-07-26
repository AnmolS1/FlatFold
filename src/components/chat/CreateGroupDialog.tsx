import { useState, type FormEvent } from 'react';
import { Users, X, Plus } from 'lucide-react';

interface CreateGroupDialogProps {
	contacts: string[];
	onClose: () => void;
	onCreate: (name: string, members: string[]) => Promise<void>;
}

const MAX_MEMBERS = 32; // v1 cap, per the spec

export const CreateGroupDialog = ({ contacts, onClose, onCreate }: CreateGroupDialogProps) => {
	const [name, setName] = useState('');
	const [selected, setSelected] = useState<string[]>([]);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const toggle = (contact: string) => {
		setSelected((prev) => (prev.includes(contact) ? prev.filter((c) => c !== contact) : [...prev, contact]));
	};

	const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError(null);
		if (!name.trim()) return setError('Give the group a name.');
		if (selected.length === 0) return setError('Add at least one member.');
		if (selected.length + 1 > MAX_MEMBERS) return setError(`Groups are capped at ${MAX_MEMBERS} members in v1.`);

		setCreating(true);
		try {
			await onCreate(name.trim(), selected);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to create group.');
			setCreating(false);
		}
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
			<div className="bg-graph-card border border-crease-line rounded-2xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
				<div className="flex items-center justify-between mb-4">
					<h2 className="font-display text-lg font-bold text-graphite flex items-center gap-2">
						<Users className="w-5 h-5" /> New group
					</h2>
					<button onClick={onClose} aria-label="Close" className="text-graphite-40 hover:text-graphite">
						<X className="w-5 h-5" />
					</button>
				</div>

				<form onSubmit={handleSubmit} className="space-y-4">
					<input
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="Group name"
						autoFocus
						className="w-full rounded-lg border border-crease-line-bold bg-inset text-graphite placeholder-graphite-40 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-crease"
					/>

					<div>
						<p className="text-xs text-graphite-60 mb-2 font-mono">Members (from your contacts)</p>
						{contacts.length === 0 ? (
							<p className="text-sm text-graphite-40">Add some contacts first, then create a group with them.</p>
						) : (
							<div className="max-h-48 overflow-y-auto border border-crease-line rounded-lg">
								{contacts.map((c) => (
									<label key={c} className="flex items-center gap-2 px-3 py-2 border-b border-crease-line last:border-b-0 cursor-pointer hover:bg-inset">
										<input type="checkbox" checked={selected.includes(c)} onChange={() => toggle(c)} className="accent-crane" />
										<span className="font-mono text-sm text-graphite">{c}</span>
									</label>
								))}
							</div>
						)}
					</div>

					{error && <p className="text-sm text-crane-ink">{error}</p>}

					<button
						type="submit"
						disabled={creating || contacts.length === 0}
						className="w-full bg-crane text-white rounded-lg py-2 hover:bg-crane-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
					>
						<Plus className="w-4 h-4" />
						{creating ? 'Creating…' : 'Create group'}
					</button>
				</form>
			</div>
		</div>
	);
};
