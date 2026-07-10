// Skeleton placeholders — the design rule is "skeletons never spinners".
// A shimmering blueprint-tinted block (see `.animate-skeleton` in index.css)
// stands in for content while it loads, so layout never jumps and there is no
// spinning "hacker app" affordance. Purely cosmetic; carries no data.

interface SkeletonProps {
	className?: string;
	/** Accessible label for the loading region (defaults to none — mark the
	    container with aria-busy instead when composing several). */
	label?: string;
}

export const Skeleton = ({ className = '', label }: SkeletonProps) => (
	<div
		className={`animate-skeleton rounded ${className}`}
		role={label ? 'status' : undefined}
		aria-label={label}
		aria-hidden={label ? undefined : true}
	/>
);

// A conversation-row skeleton for the chat list: avatar circle + two text
// lines, matching the real row's 56–64px height so the list doesn't reflow
// when messages resolve.
export const ContactRowSkeleton = () => (
	<div className="flex items-center gap-3 px-4 py-3">
		<Skeleton className="w-10 h-10 rounded-full flex-shrink-0" />
		<div className="flex-1 space-y-2">
			<Skeleton className="h-3 w-1/3" />
			<Skeleton className="h-2.5 w-2/3" />
		</div>
	</div>
);

// A message-bubble skeleton for the conversation view while history loads.
export const MessageSkeleton = ({ own = false }: { own?: boolean }) => (
	<div className={`flex ${own ? 'justify-end' : 'justify-start'} px-4 py-1`}>
		<Skeleton className={`h-9 ${own ? 'w-40' : 'w-52'} rounded-xl`} />
	</div>
);
