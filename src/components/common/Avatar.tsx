// Initials avatar. People get a circle, groups a rounded square (the design's
// shape language for 1:1 vs group). Crease-tinted, deterministic from the name
// — no uploaded images (nothing about a user's face ever touches the server),
// so this is the entire avatar system.

interface AvatarProps {
	name: string;
	group?: boolean;
	/** Pixel size of the square/circle. Rows use ~40; sheets larger. */
	size?: number;
	className?: string;
}

// First one or two "word" initials, uppercased. "ada" -> "AD"? No — a single
// handle has no spaces, so take its first two letters; a spaced group name
// ("design crew") takes one initial per word, max two.
function initialsFor(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return '?';
	const words = trimmed.split(/[\s_-]+/).filter(Boolean);
	if (words.length >= 2) {
		return (words[0][0] + words[1][0]).toUpperCase();
	}
	return trimmed.slice(0, 2).toUpperCase();
}

export const Avatar = ({ name, group = false, size = 40, className = '' }: AvatarProps) => {
	const initials = initialsFor(name);
	return (
		<div
			className={`flex-shrink-0 flex items-center justify-center bg-crease/15 text-crease font-mono font-medium select-none ${
				group ? 'rounded-lg' : 'rounded-full'
			} ${className}`}
			style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
			aria-hidden="true"
		>
			{initials}
		</div>
	);
};
