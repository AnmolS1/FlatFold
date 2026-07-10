import { useContext, createContext } from 'react';

interface ToastContextType {
	showToast: (message: string, variant: 'success' | 'error' | 'info', duration?: number) => void;
}

export const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const useToast = () => {
	const context = useContext(ToastContext);
	if (context === undefined) {
		throw new Error('useToast must be used within a ToastProvider');
	}
	return context;
};
