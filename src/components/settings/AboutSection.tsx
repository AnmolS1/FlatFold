import { Link } from 'react-router';
import { Info, ExternalLink, ShieldCheck, Mail } from 'lucide-react';
import { APP_VERSION } from '../../version';

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
