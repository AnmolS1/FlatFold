import { useState, type ReactNode } from 'react';
import { Reply, Copy, Trash2, Info, Check, CheckCheck } from 'lucide-react';
import type { DisplayMessage } from '../../types';
import { BottomSheet } from '../common/BottomSheet';
import { formatTimestamp } from '../../utils/formatTimestamp';

interface MessageActionSheetProps {
	message: DisplayMessage;
	isOwnMessage: boolean;
	// True only for our own, non-deleted, 1:1 messages (group retraction is
	// deferred). Gates the "delete for everyone" row.
	canDeleteForEveryone: boolean;
	currentUsername: string;
	onClose: () => void;
	onReply: (message: DisplayMessage) => void;
	onDeleteForMe: (message: DisplayMessage) => void;
	onDeleteForEveryone: (message: DisplayMessage) => void;
}

export const MessageActionSheet = ({
	message,
	isOwnMessage,
	canDeleteForEveryone,
	currentUsername,
	onClose,
	onReply,
	onDeleteForMe,
	onDeleteForEveryone,
}: MessageActionSheetProps) => {
	const [showDetails, setShowDetails] = useState(false);
	const [copied, setCopied] = useState(false);

	const act = (fn: () => void) => {
		fn();
		onClose();
	};

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(message.text);
			setCopied(true);
			setTimeout(onClose, 500);
		} catch {
			onClose();
		}
	};

	const canCopy = !message.deleted && message.text.trim().length > 0;

	return (
		<BottomSheet onClose={onClose} labelledBy="action-sheet-title">
			<h2 id="action-sheet-title" className="sr-only">
				Message actions
			</h2>
			<div className="px-2 pb-2">
				<Row icon={<Reply className="w-5 h-5" />} label="Reply" onClick={() => act(() => onReply(message))} />
				{canCopy && (
					<Row icon={<Copy className="w-5 h-5" />} label={copied ? 'Copied' : 'Copy text'} onClick={() => void copy()} />
				)}
				<Row icon={<Trash2 className="w-5 h-5" />} label="Delete for me" onClick={() => act(() => onDeleteForMe(message))} />
				{canDeleteForEveryone && (
					<Row
						icon={<Trash2 className="w-5 h-5" />}
						label="Delete for everyone"
						danger
						onClick={() => act(() => onDeleteForEveryone(message))}
					/>
				)}
				<Row icon={<Info className="w-5 h-5" />} label="Details" onClick={() => setShowDetails((v) => !v)} expanded={showDetails} />

				{showDetails && (
					<div className="mx-2 mb-1 rounded-lg bg-inset border border-crease-line px-3 py-2 text-xs font-mono text-graphite-60 space-y-1">
						<p>From: {isOwnMessage ? 'You' : message.from}</p>
						<p>Sent: {formatTimestamp(message.ts)}</p>
						{isOwnMessage && (
							<p className="flex items-center gap-1">
								Status: {message.status === 'delivered' ? 'Delivered' : 'Sent'}
								{message.status === 'delivered' ? <CheckCheck className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
							</p>
						)}
						{message.replyTo && <p className="truncate">Replying to {message.replyTo.from === currentUsername ? 'you' : message.replyTo.from}</p>}
					</div>
				)}
			</div>
		</BottomSheet>
	);
};

interface RowProps {
	icon: ReactNode;
	label: string;
	onClick: () => void;
	danger?: boolean;
	expanded?: boolean;
}

const Row = ({ icon, label, onClick, danger = false, expanded }: RowProps) => (
	<button
		onClick={onClick}
		aria-expanded={expanded}
		className={`w-full flex items-center gap-3 px-3 min-h-[48px] rounded-lg transition-colors ${
			danger ? 'text-crane-ink hover:bg-crane/10' : 'text-graphite hover:bg-inset'
		}`}
	>
		<span className={danger ? 'text-crane-ink' : 'text-graphite-60'}>{icon}</span>
		<span className="text-sm font-medium">{label}</span>
	</button>
);
