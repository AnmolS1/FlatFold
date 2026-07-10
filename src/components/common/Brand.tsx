import { memo, useId } from 'react';

// Inlined brand SVGs (sourced from brand/, ported to JSX). Inlining rather
// than <img>-referencing the files lets them read the page's `var(--color-*)`
// custom properties, so they follow the light/dark toggle like everything
// else instead of being frozen at build time.

interface LogoMarkProps {
	className?: string;
	size?: number;
}

const LogoMarkComponent = ({ className, size = 24 }: LogoMarkProps) => (
	<svg
		width={size}
		height={size}
		viewBox="0 0 64 64"
		fill="none"
		xmlns="http://www.w3.org/2000/svg"
		role="img"
		aria-label="FlatFold"
		className={className}
	>
		<path d="M8 8H32L56 32V56H8Z" fill="var(--color-inset, #FFFFFF)" />
		<path d="M8 8L56 56" stroke="var(--color-crease-line, rgba(46,94,140,0.13))" strokeWidth="1.5" />
		<path d="M8 56L44 20" stroke="var(--color-crease-line-bold, rgba(46,94,140,0.28))" strokeWidth="1.5" />
		<path
			d="M32 8L56 32L32 32Z"
			fill="var(--color-crane, #E84A27)"
			stroke="var(--color-crane-dark, #C23A1C)"
			strokeWidth="1"
			strokeLinejoin="round"
		/>
		<path
			d="M8 8H32L56 32V56H8Z"
			stroke="var(--color-crease, #2E5E8C)"
			strokeWidth="2.5"
			strokeLinejoin="round"
		/>
	</svg>
);

export const LogoMark = memo(LogoMarkComponent);

interface LogoWordmarkProps {
	className?: string;
	height?: number;
}

const LogoWordmarkComponent = ({ className, height = 40 }: LogoWordmarkProps) => (
	<svg
		height={height}
		viewBox="0 0 216 64"
		fill="none"
		xmlns="http://www.w3.org/2000/svg"
		role="img"
		aria-label="FlatFold"
		className={className}
	>
		<g transform="translate(0 8) scale(0.75)">
			<path d="M8 8H32L56 32V56H8Z" fill="var(--color-inset, #FFFFFF)" />
			<path d="M8 8L56 56" stroke="var(--color-crease-line, rgba(46,94,140,0.13))" strokeWidth="1.5" />
			<path d="M8 56L44 20" stroke="var(--color-crease-line-bold, rgba(46,94,140,0.28))" strokeWidth="1.5" />
			<path
				d="M32 8L56 32L32 32Z"
				fill="var(--color-crane, #E84A27)"
				stroke="var(--color-crane-dark, #C23A1C)"
				strokeWidth="1"
				strokeLinejoin="round"
			/>
			<path
				d="M8 8H32L56 32V56H8Z"
				stroke="var(--color-crease, #2E5E8C)"
				strokeWidth="2.5"
				strokeLinejoin="round"
			/>
		</g>
		<text
			x="58"
			y="42"
			fontFamily="var(--font-display, 'Bricolage Grotesque'), ui-sans-serif, system-ui, sans-serif"
			fontSize="29"
			fontWeight="650"
			letterSpacing="-0.5"
			fill="var(--color-graphite, #1B2A33)"
		>
			FlatFold
		</text>
	</svg>
);

export const LogoWordmark = memo(LogoWordmarkComponent);

interface EmptyStateIllustrationProps {
	className?: string;
}

const EmptyStateIllustrationComponent = ({ className }: EmptyStateIllustrationProps) => {
	// A stable-but-unique id per mount, so multiple instances on one page
	// (unlikely, but cheap to guard against) don't collide on the pattern id.
	const gridId = `ff-grid-${useId()}`;

	return (
		<svg
			viewBox="0 0 280 200"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			role="img"
			aria-label="An unfolded crease pattern"
			className={className}
		>
			<defs>
				<pattern id={gridId} width="20" height="20" patternUnits="userSpaceOnUse">
					<path d="M20 0H0V20" stroke="var(--color-grid-line, rgba(46,94,140,0.07))" strokeWidth="1" fill="none" />
				</pattern>
			</defs>
			<rect width="280" height="200" fill={`url(#${gridId})`} />
			<rect
				x="80"
				y="40"
				width="120"
				height="120"
				fill="var(--color-inset, #FFFFFF)"
				stroke="var(--color-crease, #2E5E8C)"
				strokeWidth="2"
			/>
			<path
				d="M80 40L200 160M200 40L80 160"
				stroke="var(--color-crease-line-bold, rgba(46,94,140,0.28))"
				strokeWidth="1.5"
			/>
			<path
				d="M140 40V160M80 100H200"
				stroke="var(--color-crease-line-bold, rgba(46,94,140,0.28))"
				strokeWidth="1.5"
				strokeDasharray="4 4"
			/>
			<circle cx="140" cy="100" r="4" fill="var(--color-crane, #E84A27)" />
			<path
				d="M72 40H64M80 32V24M208 160H216M200 168V176"
				stroke="var(--color-graphite-40, rgba(27,42,51,0.4))"
				strokeWidth="1"
			/>
		</svg>
	);
};

export const EmptyStateIllustration = memo(EmptyStateIllustrationComponent);
