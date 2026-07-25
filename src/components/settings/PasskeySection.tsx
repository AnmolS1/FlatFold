import { useState, useEffect, useCallback } from 'react';
import { Fingerprint } from 'lucide-react';
import { isNativePlatform } from '../../lib/platform';
import { createPasskeyWrappingKey, hasPlatformAuthenticator } from '../../lib/webauthnPrf';
import { enrollPasskeyUnlock, disablePasskeyUnlock, isPasskeyUnlockEnrolled } from '../../keystore';

// Web counterpart of BiometricSection. Enrolling creates a passkey and wraps the
// CURRENTLY-UNLOCKED master key under a key derived from that passkey's WebAuthn
// PRF output; disabling deletes the wrap. Hidden on native (Face ID covers it)
// and on browsers/authenticators without PRF, so we never advertise an unlock
// method that cannot actually work.
export function PasskeySection({ username }: { username: string }) {
	const [supported, setSupported] = useState(false);
	const [enrolled, setEnrolled] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (isNativePlatform()) return;
		let cancelled = false;
		void (async () => {
			const available = await hasPlatformAuthenticator();
			if (cancelled) return;
			setSupported(available);
			if (available) setEnrolled(await isPasskeyUnlockEnrolled(username));
		})();
		return () => {
			cancelled = true;
		};
	}, [username]);

	const toggle = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			if (enrolled) {
				await disablePasskeyUnlock(username);
				setEnrolled(false);
				return;
			}
			const enrollment = await createPasskeyWrappingKey(username);
			if (!enrollment) {
				// Cancelled, or the authenticator doesn't do PRF. Say so plainly
				// rather than leaving a toggle that silently did nothing.
				setError(
					'This browser or device could not create a passkey that supports unlocking (it needs WebAuthn PRF). Your password still works.'
				);
				return;
			}
			await enrollPasskeyUnlock(username, enrollment);
			setEnrolled(true);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Could not update passkey unlock.');
		} finally {
			setBusy(false);
		}
	}, [enrolled, username]);

	if (!supported) return null;

	return (
		<section className="mb-6">
			<h3 className="text-sm font-semibold text-graphite mb-2 flex items-center gap-2">
				<Fingerprint className="w-4 h-4" /> Passkey unlock
			</h3>
			<button
				onClick={() => void toggle()}
				disabled={busy}
				className="w-full text-left border border-crease-line rounded-lg p-3 hover:bg-inset transition-colors disabled:opacity-50 flex items-center justify-between"
			>
				<div className="pr-3">
					<p className="text-sm text-graphite">Unlock with a passkey</p>
					<p className="text-xs text-graphite-40">
						Skip retyping your password every time this tab reloads. Your key is wrapped so that only this
						device&rsquo;s passkey can open it, unlocked by Touch ID, Face ID, or your device PIN. Nothing is sent to
						the server, and your password still works and remains the ultimate key.
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
