import { useState, useCallback } from 'react';
import { ShieldCheck, ShieldOff, Copy, Check, ExternalLink } from 'lucide-react';
import { QrCode } from '../common/QrCode';
import { apiEnable2fa, apiDisable2fa } from '../../lib/api';
import { generateTotpSecret, buildOtpauthUri, generateBackupCodes } from '../../lib/totp';
import { copyText } from '../../lib/clipboard';

// D7 §4 — Settings two-factor. Enable: generate the secret + backup codes once,
// show the QR to scan, confirm with a live code (+ password re-auth). Disable:
// password + a valid second factor. Secret/backup codes are generated client-side
// and the plaintext leaves memory once enrollment finishes.
export function TwoFactorSection({ username, initialEnabled }: { username: string; initialEnabled: boolean }) {
	const [enabled, setEnabled] = useState(initialEnabled);
	const [draft, setDraft] = useState<{ secret: string; uri: string; backupCodes: string[] } | null>(null);
	const [password, setPassword] = useState('');
	const [code, setCode] = useState('');
	const [savedBackup, setSavedBackup] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [disarming, setDisarming] = useState(false);
	const [disablePw, setDisablePw] = useState('');
	const [disableCode, setDisableCode] = useState('');
	const [copied, setCopied] = useState<string | null>(null);

	const copy = useCallback(async (label: string, text: string) => {
		if (await copyText(text)) {
			setCopied(label);
			setTimeout(() => setCopied(null), 1500);
		}
	}, []);

	const startSetup = useCallback(() => {
		const secret = generateTotpSecret();
		setDraft({ secret, uri: buildOtpauthUri(secret, username, 'FlatFold'), backupCodes: generateBackupCodes() });
		setError(null);
		setPassword('');
		setCode('');
		setSavedBackup(false);
	}, [username]);

	const confirmEnable = useCallback(async () => {
		if (!draft) return;
		setError(null);
		setBusy(true);
		try {
			await apiEnable2fa(password, draft.secret, code, draft.backupCodes);
			setEnabled(true);
			setDraft(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Could not turn on two-factor.');
		} finally {
			setBusy(false);
		}
	}, [draft, password, code]);

	const confirmDisable = useCallback(async () => {
		setError(null);
		setBusy(true);
		try {
			await apiDisable2fa(disablePw, disableCode);
			setEnabled(false);
			setDisarming(false);
			setDisablePw('');
			setDisableCode('');
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Could not turn off two-factor.');
		} finally {
			setBusy(false);
		}
	}, [disablePw, disableCode]);

	const inputCls =
		'w-full rounded-lg border border-crease-line-bold bg-inset text-graphite placeholder-graphite-40 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-crease';

	return (
		<section className="mb-6">
			<h3 className="text-sm font-semibold text-graphite mb-2 flex items-center gap-2">
				<ShieldCheck className="w-4 h-4" /> Two-factor authentication
			</h3>

			{enabled ? (
				!disarming ? (
					<>
						<div className="flex items-center justify-between border border-sax/40 rounded-lg p-3">
							<p className="text-sm text-graphite">Two-factor is on.</p>
							<span className="text-xs font-mono px-2 py-1 rounded bg-sax/20 text-sax">ON</span>
						</div>
						<button
							onClick={() => {
								setDisarming(true);
								setError(null);
							}}
							className="mt-2 text-xs flex items-center gap-1 px-2 py-1 border border-crane/40 text-crane hover:border-crane rounded transition-colors"
						>
							<ShieldOff className="w-3.5 h-3.5" /> Turn off two-factor
						</button>
					</>
				) : (
					<div className="space-y-2 border border-crane/40 rounded-lg p-3">
						<p className="text-sm text-graphite">Turn off two-factor?</p>
						<p className="text-xs text-graphite-40">Enter your password and a current code to confirm it&rsquo;s you.</p>
						<input type="password" autoComplete="current-password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} placeholder="Password" aria-label="Password" className={inputCls} />
						<input type="text" inputMode="numeric" value={disableCode} onChange={(e) => setDisableCode(e.target.value)} placeholder="Authenticator or backup code" aria-label="Two-factor code" className={`${inputCls} font-mono`} />
						{error && <p className="text-xs text-crane">{error}</p>}
						<div className="flex gap-2">
							<button onClick={() => void confirmDisable()} disabled={busy || !disablePw || !disableCode} className="flex-1 bg-crane text-white rounded-lg py-1.5 text-sm hover:bg-crane-dark disabled:opacity-50 transition-colors">
								{busy ? 'Turning off…' : 'Turn off'}
							</button>
							<button onClick={() => { setDisarming(false); setError(null); }} className="px-3 py-1.5 border border-crease-line-bold text-graphite rounded-lg text-sm hover:border-crease transition-colors">
								Cancel
							</button>
						</div>
					</div>
				)
			) : !draft ? (
				<>
					<button onClick={startSetup} className="text-xs flex items-center gap-1 px-2 py-1 border border-crease-line-bold text-graphite hover:border-crease rounded transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-crease">
						<ShieldCheck className="w-3.5 h-3.5" /> Set up two-factor
					</button>
					<p className="text-xs text-graphite-40 mt-2">
						Add a second lock to signing in. It protects who can sign in — it doesn&rsquo;t unlock your messages on its own,
						so keep your recovery code too.
					</p>
				</>
			) : (
				<div className="space-y-3 border border-crease-line-bold rounded-lg p-3">
					<p className="text-xs text-graphite-60">
						Add this to your authenticator app, then enter a code to confirm.
					</p>
					{/* On the same phone, the QR can't be scanned — this hands the code
					    straight to an installed authenticator app. */}
					<button
						onClick={() => window.open(draft.uri, '_system')}
						className="w-full flex items-center justify-center gap-2 bg-crease text-white rounded-lg py-2 text-sm hover:opacity-90 transition-opacity"
					>
						<ExternalLink className="w-4 h-4" /> Open in your authenticator app
					</button>
					<details className="text-xs text-graphite-40">
						<summary className="cursor-pointer">On another device? Scan a QR instead</summary>
						<div className="flex justify-center mt-2">
							<div className="rounded-lg overflow-hidden bg-white p-2">
								<QrCode text={draft.uri} label="Two-factor setup QR" />
							</div>
						</div>
					</details>
					<div>
						<div className="flex items-center justify-between mb-1">
							<p className="text-xs text-graphite-40">Or enter this key manually:</p>
							<button onClick={() => void copy('key', draft.secret)} className="text-xs flex items-center gap-1 text-crease hover:text-crane transition-colors">
								{copied === 'key' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
								{copied === 'key' ? 'Copied' : 'Copy'}
							</button>
						</div>
						<p className="selectable-text font-mono text-xs text-graphite break-all bg-inset border border-crease-line rounded p-2">{draft.secret}</p>
					</div>

					<div>
						<div className="flex items-center justify-between">
							<p className="text-sm font-semibold text-graphite">Backup codes</p>
							<button onClick={() => void copy('backup', draft.backupCodes.join('\n'))} className="text-xs flex items-center gap-1 text-crease hover:text-crane transition-colors">
								{copied === 'backup' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
								{copied === 'backup' ? 'Copied' : 'Copy all'}
							</button>
						</div>
						<p className="text-xs text-graphite-40 mb-2">
							Save these somewhere safe. Each one works once, for when you don&rsquo;t have your authenticator.
						</p>
						<div className="selectable-text grid grid-cols-2 gap-1 font-mono text-xs text-graphite bg-inset border border-crease-line rounded p-2">
							{draft.backupCodes.map((c) => (
								<span key={c}>{c}</span>
							))}
						</div>
						<label className="flex items-center gap-2 mt-2 text-xs text-graphite-60">
							<input type="checkbox" checked={savedBackup} onChange={(e) => setSavedBackup(e.target.checked)} />
							I&rsquo;ve saved my backup codes
						</label>
					</div>

					<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" aria-label="Password" className={inputCls} />
					<input type="text" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code from your app" aria-label="Authenticator code" className={`${inputCls} font-mono`} />
					{error && <p className="text-xs text-crane">{error}</p>}
					<div className="flex gap-2">
						<button onClick={() => void confirmEnable()} disabled={busy || !password || !code || !savedBackup} className="flex-1 bg-crease text-white rounded-lg py-1.5 text-sm hover:opacity-90 disabled:opacity-50 transition-opacity">
							{busy ? 'Turning on…' : 'Turn on two-factor'}
						</button>
						<button onClick={() => setDraft(null)} className="px-3 py-1.5 border border-crease-line-bold text-graphite rounded-lg text-sm hover:border-crease transition-colors">
							Cancel
						</button>
					</div>
				</div>
			)}
		</section>
	);
}
