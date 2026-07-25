import { useEffect, memo, type ReactNode } from 'react';
import { CheckCircle, XCircle, Info, X } from 'lucide-react';
import { isNativePlatform } from '../../lib/platform';

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

	// Native reads as a self-dismissing iOS banner — no close affordance, tap to
	// dismiss early. Web keeps the explicit close button.
	const native = isNativePlatform();

	return (
		<div
			className={`${config.bgColor} ${config.borderColor} border rounded-xl shadow-lg px-4 py-3 flex items-center gap-3 w-full max-w-md pointer-events-auto animate-slide-down ${
				native ? 'cursor-pointer active:opacity-80 transition-opacity' : ''
			}`}
			role="alert"
			onClick={native ? () => onClose(id) : undefined}
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
	return (
		// A centred top banner that clears the status bar / Dynamic Island via the
		// safe-area inset (0 on web, so it just falls back to a top margin).
		// pointer-events-none lets taps pass through the empty gutter; each toast
		// re-enables its own.
		<div
			className="fixed left-0 right-0 top-0 z-50 flex flex-col items-center gap-2 px-4 pointer-events-none"
			style={{ paddingTop: 'max(1rem, calc(env(safe-area-inset-top) + 0.5rem))' }}
			aria-live="polite"
			aria-atomic="true"
		>
			{children}
		</div>
	);
};
