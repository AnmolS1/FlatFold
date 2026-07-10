import { useState, useCallback, type ReactNode } from 'react';
import { Toast, ToastContainer, type ToastVariant } from '../components/common/Toast';
import { ToastContext } from '../hooks/useToast';

interface ToastItem {
	id: string;
	message: string;
	variant: ToastVariant;
	duration?: number;
}

interface ToastProviderProps {
	children: ReactNode;
}

export const ToastProvider = ({ children }: ToastProviderProps) => {
	const [toasts, setToasts] = useState<ToastItem[]>([]);

	const showToast = useCallback((message: string, variant: ToastVariant, duration = 5000) => {
		const id = `toast-${Date.now()}-${Math.random()}`;
		setToasts((prev) => [...prev, { id, message, variant, duration }]);
	}, []);

	const removeToast = useCallback((id: string) => {
		setToasts((prev) => prev.filter((toast) => toast.id !== id));
	}, []);

	return (
		<ToastContext.Provider value={{ showToast }}>
			{children}
			<ToastContainer>
				{toasts.map((toast) => (
					<Toast
						key={toast.id}
						id={toast.id}
						message={toast.message}
						variant={toast.variant}
						duration={toast.duration}
						onClose={removeToast}
					/>
				))}
			</ToastContainer>
		</ToastContext.Provider>
	);
};
