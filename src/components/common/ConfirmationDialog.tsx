import { useEffect, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export interface ConfirmationDialogProps {
	isOpen: boolean;
	onClose: () => void;
	onConfirm: () => void;
	title: string;
	message: string;
	confirmText?: string;
	cancelText?: string;
	confirmButtonVariant?: 'danger' | 'primary';
	loading?: boolean;
}

const ConfirmationDialogComponent = ({
	isOpen,
	onClose,
	onConfirm,
	title,
	message,
	confirmText = 'Confirm',
	cancelText = 'Cancel',
	confirmButtonVariant = 'primary',
	loading = false,
}: ConfirmationDialogProps) => {
	const dialogRef = useRef<HTMLDivElement>(null);
	const previousFocusRef = useRef<HTMLElement | null>(null);

	// Handle Escape key
	useEffect(() => {
		if (!isOpen) return;

		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onClose();
			}
		};

		document.addEventListener('keydown', handleEscape);
		return () => document.removeEventListener('keydown', handleEscape);
	}, [isOpen, onClose]);

	// Focus management
	useEffect(() => {
		if (isOpen) {
			// Store current focused element
			previousFocusRef.current = document.activeElement as HTMLElement;

			// Focus first button in dialog
			const firstButton = dialogRef.current?.querySelector('button');
			firstButton?.focus();
		} else {
			// Return focus to previous element
			previousFocusRef.current?.focus();
		}
	}, [isOpen]);

	// Focus trap
	useEffect(() => {
		if (!isOpen || !dialogRef.current) return;

		const handleTab = (e: KeyboardEvent) => {
			if (e.key !== 'Tab') return;

			const focusableElements = dialogRef.current?.querySelectorAll<HTMLElement>(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
			);

			if (!focusableElements || focusableElements.length === 0) return;

			const firstElement = focusableElements[0];
			const lastElement = focusableElements[focusableElements.length - 1];

			if (e.shiftKey) {
				// Shift + Tab
				if (document.activeElement === firstElement) {
					e.preventDefault();
					lastElement.focus();
				}
			} else {
				// Tab
				if (document.activeElement === lastElement) {
					e.preventDefault();
					firstElement.focus();
				}
			}
		};

		document.addEventListener('keydown', handleTab);
		return () => document.removeEventListener('keydown', handleTab);
	}, [isOpen]);

	if (!isOpen) return null;

	const confirmButtonStyles =
		confirmButtonVariant === 'danger' ? 'bg-crane hover:bg-crane-dark text-white' : 'bg-crease hover:opacity-90 text-white';

	const dialog = (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center p-4"
			role="dialog"
			aria-modal="true"
			aria-labelledby="dialog-title"
			aria-describedby="dialog-description"
		>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-graphite/50" onClick={onClose} aria-hidden="true" />

			{/* Dialog */}
			<div
				ref={dialogRef}
				className="relative bg-graph-card rounded-lg shadow-[var(--shadow-card)] max-w-md w-full border border-crease-line"
			>
				{/* Header */}
				<div className="flex items-center justify-between p-4 border-b border-crease-line">
					<h2 id="dialog-title" className="font-display text-lg font-semibold text-graphite">
						{title}
					</h2>
					<button
						onClick={onClose}
						disabled={loading}
						className="text-graphite-60 hover:text-graphite transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						aria-label="Close dialog"
					>
						<X className="w-5 h-5" />
					</button>
				</div>

				{/* Content */}
				<div className="p-4">
					<p id="dialog-description" className="text-sm text-graphite-60">
						{message}
					</p>
				</div>

				{/* Actions */}
				<div className="flex items-center justify-end gap-3 p-4 border-t border-crease-line">
					<button
						onClick={onClose}
						disabled={loading}
						className="px-4 py-2 text-sm font-medium text-graphite bg-inset border border-crease-line-bold rounded-lg hover:border-crease transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{cancelText}
					</button>
					<button
						onClick={onConfirm}
						disabled={loading}
						className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 ${confirmButtonStyles}`}
					>
						{loading && <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />}
						{confirmText}
					</button>
				</div>
			</div>
		</div>
	);

	return createPortal(dialog, document.body);
};

export const ConfirmationDialog = memo(ConfirmationDialogComponent);
