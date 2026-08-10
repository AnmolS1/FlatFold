import { UserPlus, Users } from 'lucide-react';
import type { PendingGroup } from '../../lib/contactRequests';

interface MessageRequestsProps {
	senders: string[];
	groups: PendingGroup[];
	onAccept: (sender: string) => void;
	onDecline: (sender: string) => void;
	onAcceptGroup: (groupId: string) => void;
	onDeclineGroup: (groupId: string) => void;
}

// App Review 1.2, the visible half of the unknown-sender gate.
//
// WHAT THIS DELIBERATELY DOES NOT RENDER: the message. No text, no preview, no
// media thumbnail, no count, no timestamp — only the username of whoever is
// asking. That is the whole point of the mechanism: unsolicited content is never
// displayed unprompted, so a message cannot be objectionable at you before you
// have agreed to receive it. If a future change adds a preview here "for
// context", it removes the property this was built for.
export const MessageRequests = ({
	senders,
	groups,
	onAccept,
	onDecline,
	onAcceptGroup,
	onDeclineGroup,
}: MessageRequestsProps) => {
	if (senders.length === 0 && groups.length === 0) return null;

	const total = senders.length + groups.length;

	return (
		// `shrink-0` + a capped height: requests sit above the conversation list in
		// a flex column, so without this a long queue would squeeze the list (or
		// push its docked "New message" button out of the shell). Past the cap the
		// requests scroll among themselves.
		<section
			className="shrink-0 max-h-[40%] overflow-y-auto border-b border-crease-line-bold"
			aria-label="Message requests"
		>
			<h2 className="px-4 pt-3 pb-2 text-xs font-bold uppercase tracking-wide text-graphite-60">
				Requests ({total})
			</h2>
			<ul>
				{senders.map((sender) => (
					<li key={sender} className="px-4 py-3 flex items-center gap-3">
						<UserPlus className="w-4 h-4 text-graphite-40 shrink-0" aria-hidden="true" />
						<div className="min-w-0 flex-1">
							<p className="text-sm text-graphite truncate">{sender}</p>
							<p className="text-xs text-graphite-40">wants to message you</p>
						</div>
						<button
							onClick={() => onAccept(sender)}
							className="text-xs px-3 py-1 rounded-lg bg-crane text-white hover:bg-crane-dark transition-colors"
						>
							Accept
						</button>
						<button
							onClick={() => onDecline(sender)}
							className="text-xs px-3 py-1 rounded-lg border border-crease-line-bold text-graphite-60 hover:text-graphite transition-colors"
						>
							Decline
						</button>
					</li>
				))}
				{groups.map((group) => (
					<li key={group.groupId} className="px-4 py-3 flex items-center gap-3">
						<Users className="w-4 h-4 text-graphite-40 shrink-0" aria-hidden="true" />
						<div className="min-w-0 flex-1">
							{/* The inviter's username, not the group NAME — a group name is
							    sender-supplied content and would be a free text channel to
							    an un-consenting recipient. */}
							<p className="text-sm text-graphite truncate">{group.creator}</p>
							<p className="text-xs text-graphite-40">added you to a group</p>
						</div>
						<button
							onClick={() => onAcceptGroup(group.groupId)}
							className="text-xs px-3 py-1 rounded-lg bg-crane text-white hover:bg-crane-dark transition-colors"
						>
							Accept
						</button>
						<button
							onClick={() => onDeclineGroup(group.groupId)}
							className="text-xs px-3 py-1 rounded-lg border border-crease-line-bold text-graphite-60 hover:text-graphite transition-colors"
						>
							Decline
						</button>
					</li>
				))}
			</ul>
		</section>
	);
};
