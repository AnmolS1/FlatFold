import { memo, useRef, useState, type PointerEvent, type MouseEvent } from 'react';
import { Check, CheckCheck, Reply } from 'lucide-react';
import type { DisplayMessage } from '../../types';
import { formatTimestamp } from '../../utils/formatTimestamp';
import { MediaAttachment } from './MediaAttachment';

interface MessageItemProps {
	message: DisplayMessage;
	isOwnMessage: boolean;
	currentUsername: string;
	animate?: boolean;
	onReply?: (message: DisplayMessage) => void;
	onLongPress?: (message: DisplayMessage) => void;
}

// Rightward drag past this many px triggers a reply.
const SWIPE_TRIGGER = 56;
// Ignore tiny wiggles; only engage a horizontal swipe past this.
const SWIPE_ACTIVATE = 10;
// Press-and-hold this long (without moving) opens the action sheet.
const LONG_PRESS_MS = 450;

export const MessageItem = memo(({ message, isOwnMessage, currentUsername, animate = false, onReply, onLongPress }: MessageItemProps) => {
	const [dragX, setDragX] = useState(0);
	const start = useRef<{ x: number; y: number } | null>(null);
	// null = undecided, 'h' = horizontal swipe (ours), 'v' = vertical (let the
	// list scroll). Prevents the reply gesture from hijacking vertical scroll.
	const axis = useRef<null | 'h' | 'v'>(null);
	const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const cancelLongPress = () => {
		if (longPressTimer.current) {
			clearTimeout(longPressTimer.current);
			longPressTimer.current = null;
		}
	};

	const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
		start.current = { x: e.clientX, y: e.clientY };
		axis.current = null;
		// Arm long-press (touch/pen; mouse users get right-click below).
		if (onLongPress && e.pointerType !== 'mouse') {
			cancelLongPress();
			longPressTimer.current = setTimeout(() => {
				longPressTimer.current = null;
				start.current = null; // consumed — don't also fire a swipe
				onLongPress(message);
			}, LONG_PRESS_MS);
		}
	};

	const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
		if (!start.current) return;
		const dx = e.clientX - start.current.x;
		const dy = e.clientY - start.current.y;
		if (axis.current === null) {
			if (Math.abs(dx) < SWIPE_ACTIVATE && Math.abs(dy) < SWIPE_ACTIVATE) return;
			cancelLongPress(); // any real movement cancels the hold
			axis.current = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
			if (axis.current === 'h') e.currentTarget.setPointerCapture(e.pointerId);
		}
		if (axis.current !== 'h') return; // vertical → leave the scroller alone
		if (!onReply) return;
		setDragX(Math.max(0, Math.min(dx, 72))); // rightward only, capped
	};

	const endSwipe = () => {
		cancelLongPress();
		if (axis.current === 'h' && dragX >= SWIPE_TRIGGER && onReply) onReply(message);
		start.current = null;
		axis.current = null;
		setDragX(0);
	};

	const onContextMenu = (e: MouseEvent) => {
		if (!onLongPress) return;
		e.preventDefault(); // right-click opens the action sheet on desktop
		onLongPress(message);
	};

	const armed = dragX >= SWIPE_TRIGGER;

	return (
		<div className={`relative flex ${isOwnMessage ? 'justify-end' : 'justify-start'} mb-4`}>
			{/* Fold-crease reply affordance revealed as the bubble is dragged right. */}
			{dragX > 0 && (
				<div
					className="absolute left-0 top-0 bottom-0 flex items-center pl-2"
					style={{ opacity: Math.min(1, dragX / SWIPE_TRIGGER) }}
					aria-hidden="true"
				>
					<Reply className={`w-5 h-5 ${armed ? 'text-crane-ink' : 'text-graphite-40'}`} />
				</div>
			)}
			<div
				className={`max-w-[78%] ${animate ? 'animate-paper-fold' : ''}`}
				style={{ transform: dragX ? `translateX(${dragX}px)` : undefined, touchAction: 'pan-y' }}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={endSwipe}
				onPointerCancel={endSwipe}
				onContextMenu={onContextMenu}
			>
				<div
					className={`rounded-xl px-4 py-2 ${
						isOwnMessage ? 'bg-crease text-on-crease rounded-br-[4px]' : 'bg-graph-card text-graphite border border-crease-line rounded-bl-[4px]'
					}`}
				>
					{!isOwnMessage && <p className="text-xs font-semibold mb-1 font-mono text-graphite-60">{message.from}</p>}

					{/* Reply quote — display-only, peer-controlled text rendered as plain
					    text (never HTML). */}
					{message.replyTo && (
						<div
							className={`mb-1.5 rounded-md border-l-2 pl-2 pr-2 py-1 text-xs ${
								isOwnMessage ? 'border-on-crease/60 bg-on-crease/10' : 'border-crease bg-crease/5'
							}`}
						>
							<span className={`block font-mono font-semibold ${isOwnMessage ? 'text-on-crease/80' : 'text-crease'}`}>
								{message.replyTo.from === currentUsername ? 'You' : message.replyTo.from}
							</span>
							<span className={`block truncate ${isOwnMessage ? 'text-on-crease/80' : 'text-graphite-60'}`}>
								{message.replyTo.text}
							</span>
						</div>
					)}

					{message.deleted ? (
						<p className={`text-sm italic ${isOwnMessage ? 'text-on-crease/80' : 'text-graphite-40'}`}>This message was deleted</p>
					) : (
						<>
							{message.media && (
								<div className="mb-1">
									<MediaAttachment username={currentUsername} media={message.media} isOwnMessage={isOwnMessage} />
								</div>
							)}
							{message.text && <p className="text-sm break-words whitespace-pre-wrap">{message.text}</p>}
						</>
					)}

					<div
						className={`flex items-center gap-1 mt-1 text-xs font-mono ${
							isOwnMessage ? 'text-on-crease/80 justify-end' : 'text-graphite-40'
						}`}
					>
						<span>{formatTimestamp(message.ts)}</span>
						{/* Own messages only: single check = handed to the mailbox,
						    double check = recipient acked (delivered). */}
						{isOwnMessage && !message.deleted && message.status === 'sent' && <Check className="w-3.5 h-3.5" aria-label="Sent" />}
						{isOwnMessage && !message.deleted && message.status === 'delivered' && (
							<CheckCheck className="w-3.5 h-3.5" aria-label="Delivered" />
						)}
					</div>
				</div>
			</div>
		</div>
	);
});

MessageItem.displayName = 'MessageItem';
