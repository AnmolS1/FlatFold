import { memo } from 'react';
import { ArrowDown } from 'lucide-react';

interface ScrollToBottomButtonProps {
	onClick: () => void;
	visible: boolean;
}

const ScrollToBottomButtonComponent = ({ onClick, visible }: ScrollToBottomButtonProps) => {
	if (!visible) return null;

	return (
		<button
			onClick={onClick}
			className="absolute bottom-24 right-6 bg-crane hover:bg-crane-dark text-white p-3 rounded-full shadow-lg transition-all duration-300 z-10 flex items-center justify-center"
			aria-label="Scroll to bottom"
		>
			<ArrowDown className="w-5 h-5" />
		</button>
	);
};

export const ScrollToBottomButton = memo(ScrollToBottomButtonComponent);
