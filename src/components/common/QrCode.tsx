import { type ReactNode } from 'react';
import qrcode from 'qrcode-generator';

// Render a QR as an inline SVG of <rect> elements from the module matrix — no
// dangerouslySetInnerHTML, so there's no HTML-injection surface. Shared by the
// safety-number view and the 2FA otpauth code.
export function QrCode({ text, label = 'QR code', className = 'w-40 h-40' }: { text: string; label?: string; className?: string }) {
	const qr = qrcode(0, 'M');
	qr.addData(text);
	qr.make();
	const count = qr.getModuleCount();
	const margin = 2;
	const size = count + margin * 2;

	const rects: ReactNode[] = [];
	for (let row = 0; row < count; row++) {
		for (let col = 0; col < count; col++) {
			if (qr.isDark(row, col)) {
				rects.push(<rect key={`${row}-${col}`} x={col + margin} y={row + margin} width={1} height={1} fill="#000" />);
			}
		}
	}

	return (
		<svg viewBox={`0 0 ${size} ${size}`} className={className} shapeRendering="crispEdges" role="img" aria-label={label}>
			<rect x={0} y={0} width={size} height={size} fill="#fff" />
			{rects}
		</svg>
	);
}
