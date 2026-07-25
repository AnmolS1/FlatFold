import { useEffect, useRef, useState, memo, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { CheckCircle, XCircle, Info, X } from 'lucide-react';
import { isNativePlatform } from '../../lib/platform';

const SWIPE_DISMISS_PX = 40; // upward drag past this dismisses the banner

export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastProps {
	id: string;
	message: string;
	variant: ToastVariant;
	duration?: number;
	onClose: (id: string) => void;
}

interface ToastConfig {
	icon: ReactNode;
	bgColor: string;
	borderColor: string;
	textColor: string;
	iconColor: string;
}

const TOAST_CONFIGS: Record<ToastVariant, ToastConfig> = {
	success: {
		icon: <CheckCircle className="w-5 h-5" />,
		bgColor: 'bg-graph-card',
		borderColor: 'border-sax',
		textColor: 'text-graphite',
		iconColor: 'text-sax',
	},
	error: {
		icon: <XCircle className="w-5 h-5" />,
		bgColor: 'bg-graph-card',
		borderColor: 'border-crane',
		textColor: 'text-graphite',
		iconColor: 'text-crane',
	},
	info: {
		icon: <Info className="w-5 h-5" />,
		bgColor: 'bg-graph-card',
		borderColor: 'border-crease-line-bold',
		textColor: 'text-graphite',
		iconColor: 'text-crease',
	},
};

const ToastComponent = ({ id, message, variant, duration = 5000, onClose }: ToastProps) => {
	const config = TOAST_CONFIGS[variant];

	useEffect(() => {
		const timer = window.setTimeout(() => {
			onClose(id);
		}, duration);

		return () => {
			window.clearTimeout(timer);
		};
	}, [id, duration, onClose]);

	// Native reads as a self-dismissing iOS banner — no close affordance; tap to
	// dismiss, or SWIPE UP to flick it away. Web keeps the explicit close button.
	const native = isNativePlatform();

	// Swipe-up-to-dismiss: follow the finger upward, flick away past the threshold,
	// otherwise spring back. `moved` suppresses the tap-close at a swipe's end.
	const [dragY, setDragY] = useState(0);
	const start = useRef<number | null>(null);
	const moved = useRef(false);

	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		start.current = e.clientY;
		moved.current = false;
		e.currentTarget.setPointerCapture(e.pointerId);
	};
	const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (start.current === null) return;
		const dy = e.clientY - start.current;
		if (Math.abs(dy) > 3) moved.current = true;
		setDragY(Math.min(0, dy)); // upward only
	};
	const onPointerUp = () => {
		if (start.current === null) return;
		start.current = null;
		if (dragY < -SWIPE_DISMISS_PX) onClose(id);
		else setDragY(0);
	};
	const onClick = () => {
		if (moved.current) return; // end of a swipe, not a tap
		if (native) onClose(id);
	};

	return (
		<div
			className={`${config.bgColor} ${config.borderColor} border rounded-xl shadow-lg px-4 py-3 flex items-center gap-3 w-full max-w-md pointer-events-auto animate-slide-down ${
				native ? 'cursor-pointer active:opacity-90' : ''
			}`}
			role="alert"
			style={{
				transform: dragY ? `translateY(${dragY}px)` : undefined,
				opacity: dragY ? Math.max(0.2, 1 + dragY / 120) : undefined,
				touchAction: native ? 'none' : undefined,
			}}
			{...(native
				? { onPointerDown, onPointerMove, onPointerUp, onClick }
				: // Web: attach NO pointer handlers. `setPointerCapture` on this div
					// retargets the following click to the captured element, which
					// swallowed the close button's own onClick — the button looked dead.
					// The swipe/tap-to-dismiss gesture is a native affordance anyway; web
					// dismisses with the explicit button.
					{})}
		>
			<div className={config.iconColor}>{config.icon}</div>
			<p className={`${config.textColor} text-sm flex-1`}>{message}</p>
			{!native && (
				<button
					onClick={() => onClose(id)}
					className={`${config.textColor} hover:opacity-70 transition-opacity`}
					aria-label="Close notification"
				>
					<X className="w-4 h-4" />
				</button>
			)}
		</div>
	);
};

export const Toast = memo(ToastComponent);

export const ToastContainer = ({ children }: { children: ReactNode }) => {
	// Native reads as an iOS system banner, which is centred and full-width. Web
	// follows the desktop convention: stacked in the top-RIGHT corner, out of the
	// way of the app's own header.
	const native = isNativePlatform();
	return (
		// Clears the status bar / Dynamic Island via the safe-area inset (0 on web,
		// so it just falls back to a top margin). pointer-events-none lets clicks
		// pass through the empty gutter; each toast re-enables its own.
		<div
			className={`fixed left-0 right-0 top-0 z-50 flex flex-col gap-2 px-4 pointer-events-none ${
				native ? 'items-center' : 'items-end'
			}`}
			style={{ paddingTop: 'max(1rem, calc(env(safe-area-inset-top) + 0.5rem))' }}
			aria-live="polite"
			aria-atomic="true"
		>
			{children}
		</div>
	);
};
