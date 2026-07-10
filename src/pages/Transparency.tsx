import { Link } from 'react-router-dom';
import { Database, Scale, ShieldQuestion, ArrowLeft, EyeOff } from 'lucide-react';
import { LEGAL_ANSWER, SEALED_SENDER, SERVER_STATE } from '../data/serverState';
import { LogoHomeLink } from '../components/common/LogoHomeLink';
import { ThemeToggle } from '../components/common/ThemeToggle';

// A public page (no auth) that states, specifically and completely, every
// field the server persists. Driven by SERVER_STATE, which test/schema-drift
// keeps honest against the actual D1 migrations.
export const Transparency = () => {
	return (
		<div className="min-h-screen">
			<div className="max-w-3xl mx-auto px-4 py-8">
				<div className="flex items-center justify-between mb-8">
					<LogoHomeLink height={40} />
					<ThemeToggle />
				</div>

				<h1 className="font-display text-3xl font-bold text-graphite mb-3">Transparency</h1>
				<p className="text-graphite-60 mb-8">
					I built FlatFold so that when someone asks what the server knows about your messages, the answer is
					short, and you can check it yourself. So here it is. <em>Everything</em> the server stores is on this page. Nothing is left off.
				</p>

				{/* Server-persisted state */}
				<section className="mb-10">
					<h2 className="font-display text-xl font-semibold text-graphite mb-4 flex items-center gap-2">
						<Database className="w-5 h-5 text-crease" /> What the server stores
					</h2>
					<div className="space-y-4">
						{SERVER_STATE.map((store) => (
							<div key={store.name} className="border border-crease-line rounded-xl overflow-hidden">
								<div className="bg-graph-card px-4 py-3 border-b border-crease-line">
									<div className="flex items-center justify-between gap-2">
										<span className="font-mono text-sm font-semibold text-graphite">{store.name}</span>
										<span className="text-xs font-mono px-2 py-0.5 rounded-full border border-crease-line-bold text-graphite-60">
											{store.storage}
										</span>
									</div>
									<p className="text-sm text-graphite-60 mt-1">{store.purpose}</p>
								</div>
								<table className="w-full text-sm">
									<tbody>
										{store.fields.map((field) => (
											<tr key={field.name} className="border-b border-crease-line last:border-b-0">
												<td className="px-4 py-2 font-mono text-crease align-top w-1/3">{field.name}</td>
												<td className="px-4 py-2 text-graphite-60">{field.description}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						))}
					</div>
					<p className="text-xs text-graphite-40 mt-3 font-mono">
						A test checks this list against the actual database on every build, so it can&rsquo;t quietly drift
						out of date.
					</p>
				</section>

				{/* Legal request */}
				<section className="mb-10">
					<h2 className="font-display text-xl font-semibold text-graphite mb-4 flex items-center gap-2">
						<Scale className="w-5 h-5 text-crease" /> What a subpoena could compel
					</h2>
					<ul className="space-y-2">
						{LEGAL_ANSWER.map((line, i) => (
							<li key={i} className="text-sm text-graphite-60 flex gap-2">
								<span className="text-crease flex-shrink-0">—</span>
								{line}
							</li>
						))}
					</ul>
				</section>

				{/* Sealed sender — who sees what */}
				<section className="mb-10">
					<h2 className="font-display text-xl font-semibold text-graphite mb-4 flex items-center gap-2">
						<EyeOff className="w-5 h-5 text-crease" /> Sealed sender: hiding who is messaging whom
					</h2>
					<p className="text-sm text-graphite-60 mb-3">
						<span className="font-semibold text-graphite">Active mode:</span> {SEALED_SENDER.activeMode}
					</p>
					<ul className="space-y-2 mb-4">
						{SEALED_SENDER.points.map((line, i) => (
							<li key={i} className="text-sm text-graphite-60 flex gap-2">
								<span className="text-crease flex-shrink-0">—</span>
								{line}
							</li>
						))}
					</ul>
					<p className="text-sm text-graphite-60 mb-3">
						<span className="font-semibold text-graphite">The honest limit:</span> {SEALED_SENDER.residual}
					</p>
					<p className="text-xs text-graphite-40 font-mono break-all">
						Pinned gateway key (SHA-256): {SEALED_SENDER.keyPinSha256}
					</p>
				</section>

				{/* Web-client caveat */}
				<section className="mb-10 bg-sax/10 border border-sax/40 rounded-xl p-5">
					<h2 className="font-display text-lg font-semibold text-graphite mb-2 flex items-center gap-2">
						<ShieldQuestion className="w-5 h-5 text-sax" /> The honest caveat: this is a web app
					</h2>
					<p className="text-sm text-graphite-60 mb-2">
						Here is the part most apps won&rsquo;t tell you. A messenger that runs in your browser can&rsquo;t be
						as trustworthy as a real installed app, and the reason is simple. The same server that carries your
						encrypted messages also hands you the code that does the encrypting. If that server ever got hacked,
						or someone with a badge leaned on it hard enough, it could hand you bad code instead, and you&rsquo;d
						have no easy way to know.
					</p>
					<p className="text-sm text-graphite-60">
						I do what I can about it. There&rsquo;s a strict Content Security Policy so the page can&rsquo;t load
						anyone else&rsquo;s scripts. The service worker caches the app for offline use, and before it stores
						any app file it checks the bytes against a checksum baked into that build. If one doesn&rsquo;t match,
						it refuses to cache it and pops up a warning, so a quietly swapped bundle gets caught. And the builds
						are reproducible, so you can check them yourself.
					</p>
					<p className="text-sm text-graphite-60 mt-2">
						Here&rsquo;s the honest limit, because it matters: that checksum lives in the service worker, and the
						server hands you the service worker too, along with the page itself. So this raises the bar a lot,
						but it can&rsquo;t fully close the hole. A server that was truly out to get you could swap the checker
						at the same time. An installed app gets its code checked and signed once. This one ships you fresh
						code every time you open it. If the thing you&rsquo;re actually scared of is the server itself turning
						on you, use something you can verify on your own machine. I&rsquo;d rather say that outright than sell
						you something I don&rsquo;t fully believe.
					</p>
				</section>

				<Link to="/chat" className="inline-flex items-center gap-2 text-sm text-crease hover:text-crane transition-colors">
					<ArrowLeft className="w-4 h-4" /> Back to FlatFold
				</Link>
			</div>
		</div>
	);
};
