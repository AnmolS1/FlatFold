import { useEffect, useRef, useState } from 'react';
import { MoreVertical } from 'lucide-react';

interface ContactMenuProps {
	contactUsername: string;
	onRemoveContact: () => void;
	onBlockContact: () => void;
}

// Conversation-header overflow menu. Minimal by design — its one action today
// is removing the contact (which rotates my sealed-sender delivery token and
// purges local conversation state). Hand-rolled dropdown (no dep), with an
// inline confirm because removal deletes conversation history on this device.
export function ContactMenu({ contactUsername, onRemoveContact, onBlockContact }: ContactMenuProps) {
	const [open, setOpen] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	const close = () => {
		setOpen(false);
		setConfirming(false);
	};

	useEffect(() => {
		if (!open) return;
		const onDocClick = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) close();
		};
		const onEsc = (e: KeyboardEvent) => {
			if (e.key === 'Escape') close();
		};
		document.addEventListener('mousedown', onDocClick);
		document.addEventListener('keydown', onEsc);
		return () => {
			document.removeEventListener('mousedown', onDocClick);
			document.removeEventListener('keydown', onEsc);
		};
	}, [open]);

	return (
		<div ref={ref} className="relative">
			<button
				onClick={() => setOpen((v) => !v)}
				className="flex items-center justify-center w-8 h-8 text-graphite hover:text-crease rounded transition-colors"
				aria-label="Conversation options"
				aria-haspopup="menu"
				aria-expanded={open}
			>
				<MoreVertical className="w-4 h-4" />
			</button>
			{open && (
				<div role="menu" className="absolute right-0 top-full mt-1 z-20 w-60 bg-inset border border-crease-line-bold rounded-md shadow-lg p-1">
					{!confirming ? (
						<>
							<button
								role="menuitem"
								onClick={() => {
									close();
									onBlockContact();
								}}
								className="w-full text-left text-sm text-graphite px-3 py-2 rounded hover:bg-inset transition-colors"
							>
								Block contact
							</button>
							<button
								role="menuitem"
								onClick={() => setConfirming(true)}
								className="w-full text-left text-sm text-crane-ink px-3 py-2 rounded hover:bg-crane/10 transition-colors"
							>
								Remove contact
							</button>
						</>
					) : (
						<div className="px-3 py-2">
							<p className="text-xs text-graphite-60 mb-2">
								Remove {contactUsername}? This deletes your conversation history on this device.
							</p>
							<div className="flex gap-2 justify-end">
								<button onClick={() => setConfirming(false)} className="text-xs text-graphite px-2 py-1 hover:text-crease">
									Cancel
								</button>
								<button
									onClick={() => {
										close();
										onRemoveContact();
									}}
									className="text-xs text-white bg-crane px-2 py-1 rounded hover:opacity-90 transition-opacity"
								>
									Remove
								</button>
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
