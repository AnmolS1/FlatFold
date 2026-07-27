import { useEffect, useState } from 'react';

// A media element that REACT renders, for the Mac audio experiment.
//
// Why this needs to exist in app code rather than in the native probe: every
// other condition creates its <audio> imperatively — `document.createElement`
// plus `appendChild` — and every one of them loads ZERO elements, at app
// baselines from 8/40 to 38/40, where a capacity model predicts plenty of room.
// Cloning a working element into its own parent fails too. So the surviving
// hypothesis is that WebKit only grants a media loader to an element created
// during React's own commit, and the ONLY way to test that directly rather
// than by elimination is to have React create one.
//
// Gated on `window.__flatfoldDebug`, which MainViewController injects only in
// DEBUG native builds. It is therefore absent from TestFlight and the App
// Store, and absent on web entirely. It renders nothing until a probe asks.
//
// Delete this once the Mac playback question is settled — it is scaffolding,
// not a feature.
interface Request {
	count: number;
	src: string;
}

export const ExperimentAudio = () => {
	const [req, setReq] = useState<Request | null>(null);

	useEffect(() => {
		if (!(window as unknown as { __flatfoldDebug?: boolean }).__flatfoldDebug) return;
		const onAsk = (e: Event) => {
			const detail = (e as CustomEvent<Request>).detail;
			if (detail?.src && detail.count > 0) setReq({ count: detail.count, src: detail.src });
		};
		window.addEventListener('flatfold:exp-audio', onAsk);
		return () => window.removeEventListener('flatfold:exp-audio', onAsk);
	}, []);

	if (!req) return null;

	return (
		<div className="hidden" aria-hidden="true">
			{Array.from({ length: req.count }, (_, i) => (
				// `data-exp` is how the probe finds these to read readyState.
				// Rendered by React, with src set at creation — exactly how the
				// app's own working VoiceNote elements are produced.
				<audio key={i} data-exp="react" src={req.src} preload="metadata" playsInline />
			))}
		</div>
	);
};
