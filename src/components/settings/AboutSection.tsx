import { Link } from 'react-router';
import { Info, ExternalLink, ShieldCheck, Mail } from 'lucide-react';
import { APP_VERSION } from '../../version';
import { BUILD_ID, BUILT_AT } from '../../buildInfo';
import { isIOSAppOnMac, isNativePlatform } from '../../lib/platform';

const SOURCE_URL = 'https://github.com/AnmolS1/FlatFold';
const SECURITY_EMAIL = 'security@flatfold.ponderance.dev';

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
				</div>
			</div>
		</section>
	);
}
