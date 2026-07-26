import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import qrcode from 'qrcode-generator';
import { Camera, Check, ShieldCheck, ShieldAlert } from 'lucide-react';
import { computeSafetyNumber, formatSafetyNumber, type SafetyNumberIdentity } from '../../crypto';
import * as keystore from '../../keystore';
import type { ContactRecord } from '../../keystore';
import { BottomSheet } from '../common/BottomSheet';

// QR scanning decodes camera frames with jsQR (pure JS, lazy-loaded). We do NOT
// use the `BarcodeDetector` API: WKWebView (the native app) doesn't implement it,
// which silently hid the scan button on iOS — leaving a security feature
// (safety-number verification by camera) non-functional. jsQR runs anywhere
// `getUserMedia` does.

interface SafetyNumberDialogProps {
	selfUsername: string;
	contact: ContactRecord;
	onClose: () => void;
	// Persists the verified flag via the parent, which routes it through the
	// shared session-op chain (whole-record identity-doc write) and refreshes
	// contact state.
	onSetVerified: (contactUsername: string, verified: boolean) => Promise<void>;
	// When true, shows the crane key-change banner at the top of the sheet
	// (the same sheet doubles as the key-change warning surface).
	keyChanged?: boolean;
}

// Render the QR as an inline SVG of <rect> elements built from the module
// matrix — no dangerouslySetInnerHTML, so there's no HTML-injection surface
// even though the input here is only ever a locally-computed digit string.
function QrCode({ text }: { text: string }) {
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
		<svg viewBox={`0 0 ${size} ${size}`} className="w-40 h-40" shapeRendering="crispEdges" role="img" aria-label="Safety number QR code">
			<rect x={0} y={0} width={size} height={size} fill="#fff" />
			{rects}
		</svg>
	);
}

export const SafetyNumberDialog = ({ selfUsername, contact, onClose, onSetVerified, keyChanged = false }: SafetyNumberDialogProps) => {
	const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
	const [scanning, setScanning] = useState(false);
	const [scanError, setScanError] = useState<string | null>(null);
	const [verified, setVerified] = useState(contact.verified);
	const videoRef = useRef<HTMLVideoElement>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const streamRef = useRef<MediaStream | null>(null);

	const scanSupported =
		typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';

	useEffect(() => {
		let cancelled = false;
		// The iterated hash is quick but not free — compute off the initial
		// paint so the dialog appears instantly.
		keystore.getIdentity(selfUsername).then((identity) => {
			if (cancelled) return;
			const self: SafetyNumberIdentity = {
				username: selfUsername,
				signingPublicKey: identity.signing.publicKey,
				dhPublicKey: identity.dh.publicKey,
			};
			const other: SafetyNumberIdentity = {
				username: contact.username,
				signingPublicKey: contact.identity.signingPublicKey,
				dhPublicKey: contact.identity.dhPublicKey,
			};
			setSafetyNumber(computeSafetyNumber(self, other));
		});
		return () => {
			cancelled = true;
		};
	}, [selfUsername, contact]);

	const stopScanning = useCallback(() => {
		streamRef.current?.getTracks().forEach((track) => track.stop());
		streamRef.current = null;
		setScanning(false);
	}, []);

	useEffect(() => stopScanning, [stopScanning]);

	const markVerified = useCallback(
		async (value: boolean) => {
			await onSetVerified(contact.username, value);
			setVerified(value);
		},
		[contact.username, onSetVerified]
	);

	const startScanning = useCallback(async () => {
		if (!scanSupported || !safetyNumber) return;
		setScanError(null);
		setScanning(true);
		try {
			// Lazy-load the decoder so it (and the camera path) stay out of the
			// initial bundle — only pulled when someone actually verifies by QR.
			const { default: jsQR } = await import('jsqr');
			const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
			streamRef.current = stream;
			const video = videoRef.current;
			if (!video) return;
			video.srcObject = stream;
			await video.play();

			const canvas = canvasRef.current ?? document.createElement('canvas');
			canvasRef.current = canvas;
			const ctx = canvas.getContext('2d', { willReadFrequently: true });

			const tick = () => {
				if (!streamRef.current) return; // stopped
				if (ctx && video.readyState >= video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
					canvas.width = video.videoWidth;
					canvas.height = video.videoHeight;
					ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
					const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
					const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
					if (code) {
						if (code.data === safetyNumber) {
							stopScanning();
							void markVerified(true);
							return;
						}
						// A QR was read but it doesn't match — a genuine mismatch is
						// exactly the MITM signal safety numbers exist to catch.
						setScanError('That code does not match. Do NOT trust this conversation until it does.');
					}
				}
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		} catch {
			setScanError('Could not access the camera.');
			stopScanning();
		}
	}, [scanSupported, safetyNumber, stopScanning, markVerified]);

	return (
		<BottomSheet onClose={onClose} panelClassName="bg-orbit text-orbit-fg" labelledBy="safety-number-title">
			<div className="px-5 pb-5 max-w-md mx-auto w-full">
				{keyChanged && (
					// Reused for key-change warnings: a crane banner at the top of the
					// same sheet.
					<div className="-mx-5 -mt-1 mb-4 bg-crane px-5 py-2.5 text-white text-sm font-medium flex items-center gap-2">
						<ShieldAlert className="w-4 h-4 flex-shrink-0" />
						{contact.username}&rsquo;s safety number changed — re-verify before trusting this chat.
					</div>
				)}

				<h2 id="safety-number-title" className="font-display text-lg font-bold flex items-center gap-2 mb-1.5">
					<ShieldCheck className="w-5 h-5" />
					Verify {contact.username}
				</h2>
				<p className="text-sm text-orbit-fg/70 mb-4">
					Compare this safety number with {contact.username} through a channel you already trust. If it matches on both
					devices, no one is intercepting your messages.
				</p>

				{safetyNumber === null ? (
					<p className="font-mono text-sm text-orbit-fg/60 py-8 text-center">Computing…</p>
				) : (
					<>
						<div className="font-mono text-base tracking-wide bg-black/25 rounded-xl p-4 mb-4 grid grid-cols-3 gap-x-3 gap-y-2 text-center">
							{formatSafetyNumber(safetyNumber)
								.split(' ')
								.map((group, i) => (
									<span key={i}>{group}</span>
								))}
						</div>

						<div className="bg-white rounded-lg p-3 mx-auto mb-4 w-fit">
							<QrCode text={safetyNumber} />
						</div>

						{scanning && (
							<div className="mb-4">
								<video ref={videoRef} className="w-full rounded-lg bg-black" playsInline />
								<button onClick={stopScanning} className="mt-2 text-sm text-orbit-fg/70 hover:text-orbit-fg">
									Cancel scan
								</button>
							</div>
						)}

						{scanError && <p className="text-sm text-crane-ink mb-3">{scanError}</p>}

						<div className="flex flex-col gap-2">
							{verified ? (
								<div className="flex items-center justify-between gap-2">
									<span className="flex items-center gap-2 text-sax-on-orbit font-medium">
										<Check className="w-4 h-4" /> Verified
									</span>
									<button onClick={() => void markVerified(false)} className="text-sm text-orbit-fg/60 hover:text-orbit-fg underline">
										Clear verification
									</button>
								</div>
							) : (
								<>
									{scanSupported && !scanning && (
										<button
											onClick={() => void startScanning()}
											className="flex items-center justify-center gap-2 border border-orbit-fg/40 hover:border-orbit-fg rounded-lg min-h-11 py-2 transition-colors"
										>
											<Camera className="w-4 h-4" /> Scan their code
										</button>
									)}
									<button
										onClick={() => void markVerified(true)}
										className="bg-sax text-on-sax font-semibold rounded-lg min-h-11 py-2 hover:opacity-90 transition-opacity"
									>
										Mark as verified
									</button>
									{!scanSupported && (
										<p className="text-xs text-orbit-fg/60 text-center">
											Live scanning isn&rsquo;t supported in this browser — compare the digits above instead.
										</p>
									)}
								</>
							)}
						</div>
					</>
				)}
			</div>
		</BottomSheet>
	);
};
