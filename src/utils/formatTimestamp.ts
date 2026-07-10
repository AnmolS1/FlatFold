const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function clockTime(d: Date): string {
	const hours = d.getHours();
	const ampm = hours >= 12 ? 'PM' : 'AM';
	const displayHours = hours % 12 || 12;
	return `${displayHours}:${d.getMinutes().toString().padStart(2, '0')} ${ampm}`;
}

// Compact timestamp for chat-list rows: clock time today, "Yesterday",
// weekday within the last week, else a short date. Kept terse so it fits the
// right-aligned mono slot without wrapping.
export const formatListTimestamp = (ts: number | null): string => {
	if (!ts) return '';
	const now = new Date();
	const d = new Date(ts);
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const dayMs = 24 * 60 * 60 * 1000;
	if (d.getTime() >= startOfToday) return clockTime(d);
	if (d.getTime() >= startOfToday - dayMs) return 'Yesterday';
	if (d.getTime() >= startOfToday - 6 * dayMs) return WEEKDAYS[d.getDay()];
	return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

export const formatTimestamp = (ts: number | null): string => {
	if (!ts) {
		return 'Just now';
	}

	const now = new Date();
	const messageDate = new Date(ts);
	const diffInMs = now.getTime() - messageDate.getTime();
	const diffInMinutes = Math.floor(diffInMs / (1000 * 60));
	const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
	const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

	// Less than 1 minute
	if (diffInMinutes < 1) {
		return 'Just now';
	}

	// Less than 1 hour - show minutes
	if (diffInMinutes < 60) {
		return `${diffInMinutes}m ago`;
	}

	// Less than 24 hours - show hours
	if (diffInHours < 24) {
		return `${diffInHours}h ago`;
	}

	// Yesterday
	if (diffInDays === 1) {
		const hours = messageDate.getHours();
		const minutes = messageDate.getMinutes();
		const ampm = hours >= 12 ? 'PM' : 'AM';
		const displayHours = hours % 12 || 12;
		const displayMinutes = minutes.toString().padStart(2, '0');
		return `Yesterday at ${displayHours}:${displayMinutes} ${ampm}`;
	}

	// Older - show full date
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const month = months[messageDate.getMonth()];
	const day = messageDate.getDate();
	const hours = messageDate.getHours();
	const minutes = messageDate.getMinutes();
	const ampm = hours >= 12 ? 'PM' : 'AM';
	const displayHours = hours % 12 || 12;
	const displayMinutes = minutes.toString().padStart(2, '0');

	return `${month} ${day} at ${displayHours}:${displayMinutes} ${ampm}`;
};
