import { useState, useEffect, useCallback } from 'react';
import { Fingerprint } from 'lucide-react';
import { biometricAvailable } from '../../lib/biometric';
import { enrollBiometric, disableBiometric, isBiometricEnrolled } from '../../keystore';

// D7 §5 — Settings biometric unlock. Only renders on a device with biometric
// hardware (hidden on web). Enrolling stores the CURRENTLY-UNLOCKED master key in
// the Secure-Enclave-gated Keychain (custom native plugin); disabling deletes it.
export function BiometricSection({ username }: { username: string }) {
	const [supported, setSupported] = useState(false);
	const [type, setType] = useState('none');
	const [enrolled, setEnrolled] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const a = await biometricAvailable();
			if (cancelled) return;
			setSupported(a.available);
			setType(a.biometryType);
			if (a.available) setEnrolled(await isBiometricEnrolled(username));
		})();
		return () => {
			cancelled = true;
		};
	}, [username]);

	const label = type === 'faceId' ? 'Face ID' : type === 'touchId' ? 'Touch ID' : 'biometrics';

	const toggle = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			if (enrolled) {
				await disableBiometric(username);
				setEnrolled(false);
			} else {
				await enrollBiometric(username);
				setEnrolled(true);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Could not update biometric unlock.');
		} finally {
			setBusy(false);
		}
	}, [enrolled, username]);

	if (!supported) return null; // web, or no biometric hardware/enrollment

	return (
		<section className="mb-6">
			<h3 className="text-sm font-semibold text-graphite mb-2 flex items-center gap-2">
				<Fingerprint className="w-4 h-4" /> Biometric unlock
			</h3>
			<button
				onClick={() => void toggle()}
				disabled={busy}
				className="w-full text-left border border-crease-line rounded-lg p-3 hover:bg-inset transition-colors disabled:opacity-50 flex items-center justify-between"
			>
				<div className="pr-3">
					<p className="text-sm text-graphite">Unlock with {label}</p>
					<p className="text-xs text-graphite-40">
						Your key stays in the Secure Enclave — {label} releases it on this device only, and it never leaves. Your
						password still works, and remains the ultimate key.
					</p>
				</div>
				<span className={`text-xs font-mono px-2 py-1 rounded ${enrolled ? 'bg-sax/20 text-sax' : 'bg-inset text-graphite-40'}`}>
					{enrolled ? 'ON' : 'OFF'}
				</span>
			</button>
			{error && <p className="text-xs text-crane mt-2">{error}</p>}
		</section>
	);
}
