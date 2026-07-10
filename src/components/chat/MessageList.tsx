import { useEffect, useRef, useState, useCallback, memo } from 'react';
import type { DisplayMessage } from '../../types';
import { MessageItem } from './MessageItem';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { EmptyStateIllustration } from '../common/Brand';
import { MessageSkeleton } from '../common/Skeleton';

interface MessageListProps {
	messages: DisplayMessage[];
	currentUsername: string;
	loading: boolean;
	onReply?: (message: DisplayMessage) => void;
	onLongPress?: (message: DisplayMessage) => void;
}

// Centered mono day label between date-separated runs of messages.
function dayLabel(ts: number): string {
	const d = new Date(ts);
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const dayMs = 24 * 60 * 60 * 1000;
	if (d.getTime() >= startOfToday) return 'Today';
	if (d.getTime() >= startOfToday - dayMs) return 'Yesterday';
	return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function isSameDay(a: number, b: number): boolean {
	const da = new Date(a);
	const db = new Date(b);
	return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

const MessageListComponent = ({ messages, currentUsername, loading, onReply, onLongPress }: MessageListProps) => {
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const [userHasScrolled, setUserHasScrolled] = useState(false);
	const [showScrollButton, setShowScrollButton] = useState(false);

	// Paper-fold animation: play it only for messages appended AFTER the
	// initial history load (a history load shouldn't fold every bubble at
	// once). Track which ids we've already committed; anything new since the
	// last render animates, briefly.
	const seenIdsRef = useRef<Set<string>>(new Set());
	const mountedRef = useRef(false);
	const [animatingIds, setAnimatingIds] = useState<Set<string>>(new Set());

	useEffect(() => {
		const currentIds = new Set(messages.map((m) => m.id));
		if (!mountedRef.current) {
			mountedRef.current = true;
			seenIdsRef.current = currentIds; // seed — no fold for the initial load
			return;
		}
		const fresh = [...currentIds].filter((id) => !seenIdsRef.current.has(id));
		seenIdsRef.current = currentIds;
		if (fresh.length === 0) return;
		setAnimatingIds(new Set(fresh));
		const timer = setTimeout(() => setAnimatingIds(new Set()), 350);
		return () => clearTimeout(timer);
	}, [messages]);

	const scrollToBottom = useCallback(() => {
		if (!scrollContainerRef.current) return;

		scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
		setUserHasScrolled(false);
		setShowScrollButton(false);
	}, []);

	// Auto-scroll to bottom on new messages (unless user has scrolled up)
	useEffect(() => {
		if (!scrollContainerRef.current || userHasScrolled) return;

		scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
	}, [messages, userHasScrolled]);

	// Detect if user has scrolled up
	const handleScroll = useCallback(() => {
		if (!scrollContainerRef.current) return;

		const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
		const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
		const isAtBottom = distanceFromBottom < 50;

		setUserHasScrolled(!isAtBottom);
		setShowScrollButton(distanceFromBottom > 100);
	}, []);

	if (loading) {
		// Skeletons, not a spinner: a plausible conversation shape while the
		// socket connects, so the view never flashes empty or jumps.
		return (
			<div className="flex-1 flex flex-col justify-end py-4" aria-busy="true" aria-label="Connecting">
				<MessageSkeleton />
				<MessageSkeleton own />
				<MessageSkeleton />
				<MessageSkeleton own />
			</div>
		);
	}

	if (messages.length === 0) {
		return (
			<div className="flex-1 flex items-center justify-center">
				<div className="text-center">
					<EmptyStateIllustration className="w-48 mx-auto mb-4" />
					<h3 className="font-display text-lg font-semibold text-graphite mb-2">No messages yet</h3>
					<p className="text-graphite-60">Be the first to send a message!</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex-1 relative">
			<div ref={scrollContainerRef} onScroll={handleScroll} className="absolute inset-0 overflow-y-auto overscroll-contain p-4 scroll-smooth">
				{messages.map((message, i) => {
					const showDay = i === 0 || !isSameDay(messages[i - 1].ts, message.ts);
					return (
						<div key={message.id}>
							{showDay && (
								<div className="flex justify-center my-3">
									<span className="text-xs font-mono text-graphite-40 bg-graph/60 px-2 py-0.5 rounded-full">{dayLabel(message.ts)}</span>
								</div>
							)}
							<MessageItem
								message={message}
								isOwnMessage={message.from === currentUsername}
								currentUsername={currentUsername}
								animate={animatingIds.has(message.id)}
								onReply={onReply}
								onLongPress={onLongPress}
							/>
						</div>
					);
				})}
			</div>
			<ScrollToBottomButton visible={showScrollButton} onClick={scrollToBottom} />
		</div>
	);
};

export const MessageList = memo(MessageListComponent);
