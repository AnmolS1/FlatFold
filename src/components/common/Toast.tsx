import { useEffect, memo, type ReactNode } from 'react';
import { CheckCircle, XCircle, Info, X } from 'lucide-react';

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

	return (
		<div
			className={`${config.bgColor} ${config.borderColor} border rounded-lg shadow-lg p-4 flex items-start gap-3 min-w-[300px] max-w-md animate-slide-in`}
			role="alert"
		>
			<div className={config.iconColor}>{config.icon}</div>
			<p className={`${config.textColor} text-sm flex-1`}>{message}</p>
			<button
				onClick={() => onClose(id)}
				className={`${config.textColor} hover:opacity-70 transition-opacity`}
				aria-label="Close notification"
			>
				<X className="w-4 h-4" />
			</button>
		</div>
	);
};

export const Toast = memo(ToastComponent);

export const ToastContainer = ({ children }: { children: ReactNode }) => {
	return (
		<div
			className="fixed top-4 right-4 z-50 flex flex-col gap-2"
			aria-live="polite"
			aria-atomic="true"
		>
			{children}
		</div>
	);
};
