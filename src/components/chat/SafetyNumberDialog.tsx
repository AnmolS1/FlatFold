import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import qrcode from 'qrcode-generator';
import { Camera, Check, ShieldCheck, ShieldAlert } from 'lucide-react';
import { computeSafetyNumber, formatSafetyNumber, type SafetyNumberIdentity } from '../../crypto';
import * as keystore from '../../keystore';
import type { ContactRecord } from '../../keystore';
import { BottomSheet } from '../common/BottomSheet';

// The BarcodeDetector API is a native browser capability (Chromium) not yet
// in the standard TS DOM lib. Declared minimally rather than pulling in a
// JS QR-decode dependency; scanning gracefully degrades to "compare the
// digits" where it's unavailable.
interface BarcodeDetectorLike {
	detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorCtor {
	new (options?: { formats: string[] }): BarcodeDetectorLike;
}

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
	const streamRef = useRef<MediaStream | null>(null);

	const scanSupported = typeof window !== 'undefined' && 'BarcodeDetector' in window;

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
			const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
			streamRef.current = stream;
			const video = videoRef.current;
			if (!video) return;
			video.srcObject = stream;
			await video.play();

			const Detector = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
			const detector = new Detector({ formats: ['qr_code'] });

			const tick = async () => {
				if (!streamRef.current) return; // stopped
				try {
					const codes = await detector.detect(video);
					const match = codes.find((c) => c.rawValue === safetyNumber);
					if (match) {
						stopScanning();
						await markVerified(true);
						return;
					}
					if (codes.length > 0) {
						// A QR was read but it doesn't match — a genuine mismatch is
						// exactly the MITM signal safety numbers exist to catch.
						setScanError('That code does not match. Do NOT trust this conversation until it does.');
					}
				} catch {
					// transient detect error; keep trying
				}
				requestAnimationFrame(() => void tick());
			};
			void tick();
		} catch {
			setScanError('Could not access the camera.');
			stopScanning();
		}
	}, [scanSupported, safetyNumber, stopScanning, markVerified]);

	return (
		<BottomSheet onClose={onClose} panelClassName="bg-orbit text-white" labelledBy="safety-number-title">
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
				<p className="text-sm text-white/70 mb-4">
					Compare this safety number with {contact.username} through a channel you already trust. If it matches on both
					devices, no one is intercepting your messages.
				</p>

				{safetyNumber === null ? (
					<p className="font-mono text-sm text-white/60 py-8 text-center">Computing…</p>
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
								<button onClick={stopScanning} className="mt-2 text-sm text-white/70 hover:text-white">
									Cancel scan
								</button>
							</div>
						)}

						{scanError && <p className="text-sm text-crane mb-3">{scanError}</p>}

						<div className="flex flex-col gap-2">
							{verified ? (
								<div className="flex items-center justify-between gap-2">
									<span className="flex items-center gap-2 text-sax font-medium">
										<Check className="w-4 h-4" /> Verified
									</span>
									<button onClick={() => void markVerified(false)} className="text-sm text-white/60 hover:text-white underline">
										Clear verification
									</button>
								</div>
							) : (
								<>
									{scanSupported && !scanning && (
										<button
											onClick={() => void startScanning()}
											className="flex items-center justify-center gap-2 border border-white/30 hover:border-white rounded-lg min-h-11 py-2 transition-colors"
										>
											<Camera className="w-4 h-4" /> Scan their code
										</button>
									)}
									<button
										onClick={() => void markVerified(true)}
										className="bg-sax text-orbit font-semibold rounded-lg min-h-11 py-2 hover:opacity-90 transition-opacity"
									>
										Mark as verified
									</button>
									{!scanSupported && (
										<p className="text-xs text-white/50 text-center">
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
