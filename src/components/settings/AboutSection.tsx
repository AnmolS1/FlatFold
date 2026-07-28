import { Link } from 'react-router';
import { Info, ExternalLink, ShieldCheck, Mail, LifeBuoy, Lock, FileText } from 'lucide-react';
import { APP_VERSION } from '../../version';
import { BUILD_ID, BUILT_AT } from '../../buildInfo';
import { isIOSAppOnMac, isNativePlatform } from '../../lib/platform';

const SOURCE_URL = 'https://github.com/AnmolS1/FlatFold';
const SECURITY_EMAIL = 'security@flatfold.ponderance.dev';
// The product page, not the support index — someone opening this from inside
// FlatFold is asking about FlatFold.
const SUPPORT_URL = 'https://ponderance.dev/support/flatfold';
const PRIVACY_URL = 'https://ponderance.dev/privacy/';
const TERMS_URL = 'https://ponderance.dev/terms/';

// D4/"up-front" — an About row: version, that it's open source (AGPL), and the
// links that let anyone check the claims (source, what the server stores, how to
// report a security issue).
export function AboutSection() {
	return (
		<section className="mb-6">
			<h3 className="text-sm font-semibold text-graphite mb-2 flex items-center gap-2">
				<Info className="w-4 h-4" /> About
			</h3>
			<div className="border border-crease-line rounded-lg p-3 space-y-2 text-sm">
				<div className="flex items-center justify-between">
					<span className="text-graphite">FlatFold</span>
					<span className="font-mono text-xs text-graphite-40">v{APP_VERSION}</span>
				</div>
				{/* The build, not just the version. A native rebuild that was not
				    force-quit keeps the OLD JavaScript, and the web shell is pinned by
				    a service worker — so "still broken" is ambiguous without this.
				    Quote it in bug reports. */}
				{/* Platform detection, shown because getting it WRONG is invisible and
				    has already cost two debugging rounds: the iPad app on a Mac reports
				    a phantom keyboard, and the app has to know it is there. If a
				    keyboard-related layout bug reappears, this line says immediately
				    whether detection or the fix is at fault. */}
				{isNativePlatform() && (
					<div className="flex items-center justify-between">
						<span className="text-xs text-graphite-40">Platform</span>
						<span className="font-mono text-xs text-graphite-40 selectable-text">
							{isIOSAppOnMac() ? 'iPad app on Mac' : 'iOS/iPadOS'} · touch {typeof navigator !== 'undefined' ? navigator.maxTouchPoints : '?'}
						</span>
					</div>
				)}
				<div className="flex items-center justify-between">
					<span className="text-xs text-graphite-40">Build</span>
					<span className="font-mono text-xs text-graphite-40 selectable-text">
						{BUILD_ID}
						{BUILT_AT ? ` · ${BUILT_AT}` : ''}
					</span>
				</div>
				<p className="text-xs text-graphite-40">
					Free and open source under AGPL-3.0 — an encrypted messenger asks for trust, so the code is public and anyone
					can read exactly how it works.
				</p>
				<div className="flex flex-col gap-1.5 pt-1">
					<a
						href={SOURCE_URL}
						target="_blank"
						rel="noopener noreferrer"
						className="flex items-center gap-2 text-crease hover:text-crane-ink transition-colors"
					>
						<ExternalLink className="w-4 h-4" /> View source
					</a>
					<Link to="/transparency" className="flex items-center gap-2 text-crease hover:text-crane-ink transition-colors">
						<ShieldCheck className="w-4 h-4" /> What the server stores
					</Link>
					<a
						href={`mailto:${SECURITY_EMAIL}`}
						className="flex items-center gap-2 text-crease hover:text-crane-ink transition-colors"
					>
						<Mail className="w-4 h-4" /> Report a security issue
					</a>
					{/* Support, Privacy and Terms live HERE because the login screen was
					    the only place that linked Privacy and Terms — so every user past
					    day one had no route to either — and Support was not linked from
					    anywhere in the app at all. The login links stay: they serve a
					    different moment, before there is an account to have settings for.

					    `target="_blank"` matches "View source" above, and that pattern was
					    measured rather than assumed. On BOTH Mac Catalyst and a real
					    iPhone, clicking it left `location.href` at
					    `capacitor://localhost/chat` with the app intact — Capacitor's
					    WebViewDelegationHandler cancels any top-level navigation to a
					    non-application URL and hands it to `UIApplication.shared.open`,
					    and this app sets no `allowNavigation` hosts to override that. So
					    an external link cannot strand the user in a chrome-less web page,
					    which is the one thing that would have made these links a bug
					    rather than a fix. */}
					<a
						href={SUPPORT_URL}
						target="_blank"
						rel="noopener noreferrer"
						className="flex items-center gap-2 text-crease hover:text-crane-ink transition-colors"
					>
						<LifeBuoy className="w-4 h-4" /> Support
					</a>
					<a
						href={PRIVACY_URL}
						target="_blank"
						rel="noopener noreferrer"
						className="flex items-center gap-2 text-crease hover:text-crane-ink transition-colors"
					>
						<Lock className="w-4 h-4" /> Privacy policy
					</a>
					<a
						href={TERMS_URL}
						target="_blank"
						rel="noopener noreferrer"
						className="flex items-center gap-2 text-crease hover:text-crane-ink transition-colors"
					>
						<FileText className="w-4 h-4" /> Terms
					</a>
				</div>
			</div>
		</section>
	);
}
