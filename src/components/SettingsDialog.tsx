import { useCallback, useEffect, useState } from 'react';
import { useModalDialog } from '../hooks/useModalDialog';
import { X, Monitor, Bell, BellOff, LogOut, Trash2, AlertTriangle, KeyRound, LifeBuoy } from 'lucide-react';
import { apiDeleteAccount, apiLogoutAll, apiMe } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { panicWipe } from '../lib/panicWipe';
import { TwoFactorSection } from './settings/TwoFactorSection';
import { BiometricSection } from './settings/BiometricSection';
import { PasskeySection } from './settings/PasskeySection';
import { ThemeSection } from './settings/ThemeSection';
import { AppIconSection } from './settings/AppIconSection';
import { AboutSection } from './settings/AboutSection';
import {
	DEFAULT_DECOY_LABEL,
	getDecoyLabel,
	isPushSupported,
	isSubscribedToPush,
	setDecoyLabel,
	subscribeToPush,
	unsubscribeFromPush,
} from '../lib/push';

interface SettingsDialogProps {
	username: string;
	onClose: () => void;
	onSignOut: () => void;
}

export const SettingsDialog = ({ username, onClose, onSignOut }: SettingsDialogProps) => {
	// Focus trap, Esc-to-close, focus restore, scroll lock — same contract the
	// bottom sheets get.
	const panelRef = useModalDialog<HTMLDivElement>(onClose);
	const { changePassword, enrollRecovery } = useAuth();
	const [sessionStart, setSessionStart] = useState<number | null>(null);
	const [twoFactorEnabled, setTwoFactorEnabled] = useState<boolean | null>(null);
	const [pushSupported] = useState(() => isPushSupported());
	const [subscribed, setSubscribed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [decoy, setDecoy] = useState(() => getDecoyLabel());
	const [pushMessage, setPushMessage] = useState<string | null>(null);

	useEffect(() => {
		apiMe().then((me) => {
			setSessionStart(me?.sessionCreatedAt ?? null);
			setTwoFactorEnabled(me?.twoFactorEnabled ?? false);
		});
		if (pushSupported) isSubscribedToPush().then(setSubscribed);
	}, [pushSupported]);

	const toggleNotifications = useCallback(async () => {
		setBusy(true);
		setPushMessage(null);
		try {
			if (subscribed) {
				await unsubscribeFromPush();
				setSubscribed(false);
			} else {
				const result = await subscribeToPush();
				if (result === 'subscribed') {
					setSubscribed(true);
					await setDecoyLabel(decoy);
				} else if (result === 'denied') {
					setPushMessage('Notification permission was denied.');
				} else {
					const { getLastPushError } = await import('../lib/nativePush');
					setPushMessage(getLastPushError() ?? 'Could not enable notifications.');
				}
			}
		} finally {
			setBusy(false);
		}
	}, [subscribed, decoy]);

	const saveDecoy = useCallback(async () => {
		await setDecoyLabel(decoy || DEFAULT_DECOY_LABEL);
	}, [decoy]);

	const [deleteArmed, setDeleteArmed] = useState(false);
	const [deletePassword, setDeletePassword] = useState('');
	const [deleting, setDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);

	// "Sign out everywhere" (L3) — password-gated, mirrors the delete flow.
	const [signOutAllArmed, setSignOutAllArmed] = useState(false);
	const [signOutAllPassword, setSignOutAllPassword] = useState('');
	const [signOutAllBusy, setSignOutAllBusy] = useState(false);
	const [signOutAllError, setSignOutAllError] = useState<string | null>(null);

	const signOutEverywhere = useCallback(async () => {
		setSignOutAllBusy(true);
		setSignOutAllError(null);
		try {
			await apiLogoutAll(signOutAllPassword);
			// Server bumped the epoch (all sessions incl. this one are now invalid)
			// and cleared this cookie. Leave the local keystore intact and go to
			// login — this ends logins, not the account.
			window.location.href = '/login';
		} catch (err) {
			setSignOutAllError(err instanceof Error ? err.message : 'Could not sign out everywhere.');
			setSignOutAllBusy(false);
		}
	}, [signOutAllPassword]);

	// Change password (D7 §1).
	const [changeArmed, setChangeArmed] = useState(false);
	const [currentPassword, setCurrentPassword] = useState('');
	const [newPassword, setNewPassword] = useState('');
	const [confirmPassword, setConfirmPassword] = useState('');
	const [changeBusy, setChangeBusy] = useState(false);
	const [changeError, setChangeError] = useState<string | null>(null);
	const [changeDone, setChangeDone] = useState(false);

	const resetChangeForm = useCallback(() => {
		setChangeArmed(false);
		setCurrentPassword('');
		setNewPassword('');
		setConfirmPassword('');
		setChangeError(null);
	}, []);

	const submitChangePassword = useCallback(async () => {
		setChangeError(null);
		if (newPassword.length < 8) {
			setChangeError('Your new password needs to be at least 8 characters.');
			return;
		}
		if (newPassword !== confirmPassword) {
			setChangeError('Those two don’t match. Type the new password the same way twice.');
			return;
		}
		if (newPassword === currentPassword) {
			setChangeError('That’s your current password. Pick a new one.');
			return;
		}
		setChangeBusy(true);
		try {
			const result = await changePassword(currentPassword, newPassword);
			if (result === 'wrong-password') {
				setChangeError('That current password isn’t right.');
				return;
			}
			resetChangeForm();
			setChangeDone(true);
		} catch (err) {
			setChangeError(err instanceof Error ? err.message : 'Could not change your password.');
		} finally {
			setChangeBusy(false);
		}
	}, [changePassword, currentPassword, newPassword, confirmPassword, resetChangeForm]);

	// Recovery code (D7 §3).
	const [recoveryArmed, setRecoveryArmed] = useState(false);
	const [recoveryPassword, setRecoveryPassword] = useState('');
	const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
	const [recoveryBusy, setRecoveryBusy] = useState(false);
	const [recoveryError, setRecoveryError] = useState<string | null>(null);

	const startRecoverySetup = useCallback(async () => {
		setRecoveryError(null);
		setRecoveryBusy(true);
		try {
			const code = await enrollRecovery(recoveryPassword);
			setRecoveryCode(code);
			setRecoveryPassword('');
		} catch (err) {
			setRecoveryError(err instanceof Error ? err.message : 'Could not set up a recovery code.');
		} finally {
			setRecoveryBusy(false);
		}
	}, [enrollRecovery, recoveryPassword]);

	const finishRecoverySetup = useCallback(() => {
		setRecoveryCode(null);
		setRecoveryArmed(false);
		setRecoveryError(null);
	}, []);

	const deleteAccount = useCallback(async () => {
		setDeleting(true);
		setDeleteError(null);
		try {
			// Server deletes the D1 rows + queued ciphertext (after password
			// re-auth); then wipe ALL local state and hard-redirect.
			await apiDeleteAccount(deletePassword);
			await panicWipe(async () => {});
			window.location.href = '/login';
		} catch (err) {
			setDeleteError(err instanceof Error ? err.message : 'Could not delete account.');
			setDeleting(false);
		}
	}, [deletePassword]);

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
			onClick={onClose}
			role="dialog"
			aria-modal="true"
			aria-labelledby="settings-dialog-title"
		>
			<div
				ref={panelRef}
				tabIndex={-1}
				className="bg-graph-card border border-crease-line rounded-2xl max-w-md w-full p-6 max-h-[70vh] overflow-y-auto focus:outline-none"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between mb-5">
					<h2 id="settings-dialog-title" className="font-display text-lg font-bold text-graphite">
						Settings
					</h2>
					<button onClick={onClose} aria-label="Close" className="text-graphite-40 hover:text-graphite">
						<X className="w-5 h-5" />
					</button>
				</div>

				{/* Session manager */}
				<section className="mb-6">
					<h3 className="text-sm font-semibold text-graphite mb-2 flex items-center gap-2">
						<Monitor className="w-4 h-4" /> Sessions
					</h3>
					<div className="border border-crease-line rounded-lg p-3 flex items-center justify-between">
						<div>
							<p className="text-sm font-mono text-graphite">This device</p>
							<p className="text-xs text-graphite-40">
								{sessionStart ? `Signed in ${new Date(sessionStart * 1000).toLocaleString()}` : 'Current session'}
							</p>
						</div>
						<button
							onClick={onSignOut}
							className="text-xs flex items-center gap-1 px-2 py-1 border border-crane/40 text-crane hover:border-crane rounded transition-colors"
						>
							<LogOut className="w-3.5 h-3.5" /> Sign out
						</button>
					</div>
					{/* Sign out everywhere (L3) */}
					<div className="mt-3">
						{!signOutAllArmed ? (
							<button
								onClick={() => setSignOutAllArmed(true)}
								className="text-xs flex items-center gap-1 px-2 py-1 border border-crane/40 text-crane hover:border-crane rounded transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-crane"
							>
								<LogOut className="w-3.5 h-3.5" /> Sign out everywhere
							</button>
						) : (
							<div className="space-y-2 border border-crane/40 rounded-lg p-3">
								<p className="text-sm font-semibold text-graphite">Sign out everywhere?</p>
								<p className="text-xs text-graphite-40">
									This signs you out on every device, including this one. You&rsquo;ll need to log back in. It
									doesn&rsquo;t touch your messages or your account, only your logins.
								</p>
								<input
									type="password"
									value={signOutAllPassword}
									onChange={(e) => setSignOutAllPassword(e.target.value)}
									placeholder="Password"
									aria-label="Password"
									className="w-full rounded-lg border border-crane/40 bg-inset text-graphite placeholder-graphite-40 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-crane"
								/>
								<p className="text-xs text-graphite-40">Enter your password to confirm it&rsquo;s you.</p>
								{signOutAllError && <p className="text-xs text-crane">{signOutAllError}</p>}
								<div className="flex gap-2">
									<button
										onClick={() => void signOutEverywhere()}
										disabled={signOutAllBusy || !signOutAllPassword}
										className="flex-1 bg-crane text-white rounded-lg py-1.5 text-sm hover:bg-crane-dark disabled:opacity-50 transition-colors"
									>
										{signOutAllBusy ? 'Signing out…' : 'Sign out everywhere'}
									</button>
									<button
										onClick={() => {
											setSignOutAllArmed(false);
											setSignOutAllPassword('');
											setSignOutAllError(null);
										}}
										className="px-3 py-1.5 border border-crease-line-bold text-graphite rounded-lg text-sm hover:border-crease transition-colors"
									>
										Cancel
									</button>
								</div>
							</div>
						)}
					</div>
					<p className="text-xs text-graphite-40 mt-2">
						&ldquo;Sign out&rdquo; ends this device&rsquo;s session. &ldquo;Sign out everywhere&rdquo; ends every
						session at once, the blunt fix if you lost a device or think someone else got in. There&rsquo;s no
						device list to show you, and that&rsquo;s on purpose. The server doesn&rsquo;t track your devices.
					</p>
				</section>

				{/* Appearance — theme picker (D3) */}
				<ThemeSection />

				{/* App icon picker (native only — self-hides on web) */}
				<AppIconSection />

				{/* Change password (D7 §1) */}
				<section className="mb-6">
					<h3 className="text-sm font-semibold text-graphite mb-2 flex items-center gap-2">
						<KeyRound className="w-4 h-4" /> Password
					</h3>
					{!changeArmed ? (
						<>
							<button
								onClick={() => {
									setChangeArmed(true);
									setChangeDone(false);
								}}
								className="text-xs flex items-center gap-1 px-2 py-1 border border-crease-line-bold text-graphite hover:border-crease rounded transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-crease"
							>
								<KeyRound className="w-3.5 h-3.5" /> Change password
							</button>
							{changeDone && <p className="text-xs text-sax mt-2">Password changed. Every other device has been signed out.</p>}
						</>
					) : (
						<div className="space-y-2 border border-crease-line-bold rounded-lg p-3">
							<p className="text-xs text-graphite-40">
								Your password does two jobs — it signs you in, and it unlocks your messages on this device. Changing it
								re-locks both under the new one and signs you out everywhere else. You need your current password to do
								it, so no one can change it out from under you.
							</p>
							<input
								type="password"
								autoComplete="current-password"
								value={currentPassword}
								onChange={(e) => setCurrentPassword(e.target.value)}
								placeholder="Current password"
								aria-label="Current password"
								className="w-full rounded-lg border border-crease-line-bold bg-inset text-graphite placeholder-graphite-40 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-crease"
							/>
							<input
								type="password"
								autoComplete="new-password"
								value={newPassword}
								onChange={(e) => setNewPassword(e.target.value)}
								placeholder="New password"
								aria-label="New password"
								className="w-full rounded-lg border border-crease-line-bold bg-inset text-graphite placeholder-graphite-40 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-crease"
							/>
							<input
								type="password"
								autoComplete="new-password"
								value={confirmPassword}
								onChange={(e) => setConfirmPassword(e.target.value)}
								placeholder="Confirm new password"
								aria-label="Confirm new password"
								className="w-full rounded-lg border border-crease-line-bold bg-inset text-graphite placeholder-graphite-40 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-crease"
							/>
							{changeError && <p className="text-xs text-crane">{changeError}</p>}
							<div className="flex gap-2">
								<button
									onClick={() => void submitChangePassword()}
									disabled={changeBusy || !currentPassword || !newPassword || !confirmPassword}
									className="flex-1 bg-crease text-white rounded-lg py-1.5 text-sm hover:opacity-90 disabled:opacity-50 transition-opacity"
								>
									{changeBusy ? 'Changing…' : 'Change password'}
								</button>
								<button
									onClick={resetChangeForm}
									className="px-3 py-1.5 border border-crease-line-bold text-graphite rounded-lg text-sm hover:border-crease transition-colors"
								>
									Cancel
								</button>
							</div>
						</div>
					)}
				</section>

				{/* Recovery code (D7 §3) */}
				<section className="mb-6">
					<h3 className="text-sm font-semibold text-graphite mb-2 flex items-center gap-2">
						<LifeBuoy className="w-4 h-4" /> Recovery code
					</h3>
					{recoveryCode ? (
						<div className="space-y-3 border border-sax/40 rounded-lg p-3">
							<p className="text-sm font-semibold text-graphite">Your recovery code</p>
							<p className="text-xs text-graphite-60">
								Write these twelve words down and keep them somewhere safe and private. If you forget your password, this is
								what gets you back into your account — your identity and your contacts. If you lose both your password and
								this code, no one can get the account back, not even me. That&rsquo;s the point.
							</p>
							<div className="selectable-text font-mono text-sm text-graphite bg-inset border border-crease-line-bold rounded-lg p-3 leading-relaxed break-words">
								{recoveryCode}
							</div>
							<button
								onClick={finishRecoverySetup}
								className="w-full bg-sax text-white rounded-lg py-1.5 text-sm hover:opacity-90 transition-opacity"
							>
								I&rsquo;ve saved my recovery code
							</button>
						</div>
					) : !recoveryArmed ? (
						<>
							<button
								onClick={() => setRecoveryArmed(true)}
								className="text-xs flex items-center gap-1 px-2 py-1 border border-crease-line-bold text-graphite hover:border-crease rounded transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-crease"
							>
								<LifeBuoy className="w-3.5 h-3.5" /> Set up a recovery code
							</button>
							<p className="text-xs text-graphite-40 mt-2">
								A recovery code is your only way back in if you forget your password. Without one, a forgotten password
								means a lost account — that&rsquo;s the honest tradeoff for a server that can&rsquo;t unlock your messages.
							</p>
						</>
					) : (
						<div className="space-y-2 border border-crease-line-bold rounded-lg p-3">
							<p className="text-sm text-graphite">Enter your password to generate a recovery code.</p>
							<input
								type="password"
								autoComplete="current-password"
								value={recoveryPassword}
								onChange={(e) => setRecoveryPassword(e.target.value)}
								placeholder="Password"
								aria-label="Password"
								className="w-full rounded-lg border border-crease-line-bold bg-inset text-graphite placeholder-graphite-40 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-crease"
							/>
							{recoveryError && <p className="text-xs text-crane">{recoveryError}</p>}
							<div className="flex gap-2">
								<button
									onClick={() => void startRecoverySetup()}
									disabled={recoveryBusy || !recoveryPassword}
									className="flex-1 bg-crease text-white rounded-lg py-1.5 text-sm hover:opacity-90 disabled:opacity-50 transition-opacity"
								>
									{recoveryBusy ? 'Generating…' : 'Generate code'}
								</button>
								<button
									onClick={() => {
										setRecoveryArmed(false);
										setRecoveryPassword('');
										setRecoveryError(null);
									}}
									className="px-3 py-1.5 border border-crease-line-bold text-graphite rounded-lg text-sm hover:border-crease transition-colors"
								>
									Cancel
								</button>
							</div>
						</div>
					)}
				</section>

				{/* Two-factor authentication (D7 §4) */}
				{twoFactorEnabled !== null && <TwoFactorSection username={username} initialEnabled={twoFactorEnabled} />}

				{/* Biometric unlock (D7 §5, native — self-hides on web) */}
				<BiometricSection username={username} />
				<PasskeySection username={username} />

				{/* Notifications + decoy label */}
				<section>
					<h3 className="text-sm font-semibold text-graphite mb-2 flex items-center gap-2">
						{subscribed ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />} Notifications
					</h3>
					{!pushSupported ? (
						<p className="text-sm text-graphite-40">Push notifications aren&rsquo;t supported in this browser.</p>
					) : (
						<>
							<button
								onClick={() => void toggleNotifications()}
								disabled={busy}
								className="w-full text-left border border-crease-line rounded-lg p-3 hover:bg-inset transition-colors disabled:opacity-50 flex items-center justify-between"
							>
								<div>
									<p className="text-sm text-graphite">{subscribed ? 'Notifications on' : 'Enable notifications'}</p>
									<p className="text-xs text-graphite-40">
										Wake-ups only — the push carries no message text or sender, ever.
									</p>
								</div>
								<span className={`text-xs font-mono px-2 py-1 rounded ${subscribed ? 'bg-sax/20 text-sax' : 'bg-inset text-graphite-40'}`}>
									{subscribed ? 'ON' : 'OFF'}
								</span>
							</button>
							{pushMessage && <p className="text-xs text-crane mt-2">{pushMessage}</p>}

							<div className="mt-4">
								<label className="text-xs text-graphite-60 block mb-1">
									Decoy notification label (shoulder-surfing protection)
								</label>
								<div className="flex gap-2">
									<input
										value={decoy}
										onChange={(e) => setDecoy(e.target.value)}
										onBlur={() => void saveDecoy()}
										placeholder={DEFAULT_DECOY_LABEL}
										className="flex-1 rounded-lg border border-crease-line-bold bg-inset text-graphite placeholder-graphite-40 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-crease"
									/>
									<button onClick={() => void saveDecoy()} className="px-3 py-1.5 bg-crease text-white rounded-lg text-sm hover:opacity-90 transition-opacity">
										Save
									</button>
								</div>
								<p className="text-xs text-graphite-40 mt-1">
									Notifications show this label (e.g. &ldquo;Calendar&rdquo;, &ldquo;News update&rdquo;) instead of
									anything identifying FlatFold. Current user: {username}.
								</p>
							</div>
						</>
					)}
				</section>

				{/* About (D4 / up-front) */}
				<AboutSection />

				{/* Danger zone — account deletion */}
				<section className="mt-6 border border-crane/40 rounded-lg p-4">
					<h3 className="text-sm font-semibold text-crane mb-2 flex items-center gap-2">
						<AlertTriangle className="w-4 h-4" /> Delete account
					</h3>
					<p className="text-xs text-graphite-40 mb-3">
						Permanently deletes your account and everything the server holds — your row, published keys, and any
						queued ciphertext — and wipes this device. This cannot be undone.
					</p>
					{!deleteArmed ? (
						<button
							onClick={() => setDeleteArmed(true)}
							className="text-xs flex items-center gap-1 px-3 py-1.5 border border-crane/40 text-crane hover:border-crane rounded transition-colors"
						>
							<Trash2 className="w-3.5 h-3.5" /> Delete my account
						</button>
					) : (
						<div className="space-y-2">
							<input
								type="password"
								value={deletePassword}
								onChange={(e) => setDeletePassword(e.target.value)}
								placeholder="Confirm your password"
								className="w-full rounded-lg border border-crane/40 bg-inset text-graphite placeholder-graphite-40 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-crane"
							/>
							{deleteError && <p className="text-xs text-crane">{deleteError}</p>}
							<div className="flex gap-2">
								<button
									onClick={() => void deleteAccount()}
									disabled={deleting || !deletePassword}
									className="flex-1 bg-crane text-white rounded-lg py-1.5 text-sm hover:bg-crane-dark disabled:opacity-50 transition-colors"
								>
									{deleting ? 'Deleting…' : 'Permanently delete'}
								</button>
								<button
									onClick={() => {
										setDeleteArmed(false);
										setDeletePassword('');
										setDeleteError(null);
									}}
									className="px-3 py-1.5 border border-crease-line-bold text-graphite rounded-lg text-sm hover:border-crease transition-colors"
								>
									Cancel
								</button>
							</div>
						</div>
					)}
				</section>
			</div>
		</div>
	);
};
