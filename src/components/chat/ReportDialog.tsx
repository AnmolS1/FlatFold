import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { DisplayMessage } from '../../types';
import type { ReportEvidenceMessage } from '../../lib/api';

interface ReportDialogProps {
	reported: string;
	/** The open conversation, so the reporter can pick out what they mean. */
	messages: DisplayMessage[];
	onSubmit: (reason: string, evidence: ReportEvidenceMessage[]) => Promise<void>;
	onClose: () => void;
}

// App Review 1.2: flagging objectionable content, in an app where the server
// cannot read messages.
//
// THE CONSENT STEP IS THE POINT, not a formality. Everywhere else in FlatFold,
// message text is unreadable to the server — that is the whole promise. This is
// the one screen that can break it, and it may only do so because a person chose
// to, for messages they chose, having been told plainly what is being sent. So:
//
//  - nothing is attached by default (every checkbox starts off);
//  - only the SELECTED messages are ever sent, never the conversation;
//  - the disclosure is in plain words, above the button, not in a link;
//  - reporting with no messages attached is allowed, and is one click.
//
// If a future change makes attachment automatic or default-on, it has broken the
// promise the rest of the app is built on. Don't.
export function ReportDialog({ reported, messages, onSubmit, onClose }: ReportDialogProps) {
	const [reason, setReason] = useState('');
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Only THEIR messages can be evidence — reporting someone by attaching your
	// own words to it would disclose your side for no purpose.
	const theirMessages = messages.filter((m) => m.from === reported && !m.deleted && m.text);

	const toggle = (id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const handleSubmit = async () => {
		setError(null);
		setSubmitting(true);
		try {
			const evidence: ReportEvidenceMessage[] = theirMessages
				.filter((m) => selected.has(m.id))
				.map((m) => ({ from: m.from, ts: m.ts, text: m.text }));
			await onSubmit(reason.trim(), evidence);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Could not send that report.');
			setSubmitting(false);
		}
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="report-title"
				className="bg-graph-card rounded-lg border border-crease-line-bold w-full max-w-md max-h-[85dvh] flex flex-col"
			>
				<div className="px-4 pt-4 shrink-0">
					<h2 id="report-title" className="font-display text-lg font-bold text-graphite flex items-center gap-2">
						<AlertTriangle className="w-5 h-5 text-crane-ink" aria-hidden="true" />
						Report {reported}
					</h2>
					<p className="text-sm text-graphite-60 mt-1">
						Reports are reviewed within 24 hours. Accounts sending objectionable content are terminated.
					</p>
				</div>

				<div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
					<label className="block">
						<span className="text-sm text-graphite">What is wrong?</span>
						<textarea
							value={reason}
							onChange={(e) => setReason(e.target.value)}
							rows={3}
							maxLength={2000}
							className="mt-1 w-full rounded-lg border border-crease-line-bold bg-inset text-graphite placeholder-graphite-40 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-crease focus:border-transparent"
							placeholder="Optional, but it helps."
						/>
					</label>

					{theirMessages.length > 0 && (
						<div>
							<h3 className="text-sm text-graphite mb-1">Include messages?</h3>
							{/* The disclosure. Plain language, visible without scrolling past
							    the checkboxes, and it says what actually happens. */}
							<p className="text-xs text-graphite-60 mb-2">
								This sends the messages you pick to the developer so a person can review them. Normally nobody
								but you and {reported} can read them. Nothing is sent unless you tick it.
							</p>
							<ul className="space-y-1">
								{theirMessages.slice(-30).map((m) => (
									<li key={m.id}>
										<label className="flex items-start gap-2 text-xs text-graphite-60 cursor-pointer">
											<input
												type="checkbox"
												checked={selected.has(m.id)}
												onChange={() => toggle(m.id)}
												className="mt-0.5 shrink-0"
											/>
											<span className="truncate">{m.text}</span>
										</label>
									</li>
								))}
							</ul>
						</div>
					)}

					{error && <p className="text-sm text-crane-ink">{error}</p>}
				</div>

				<div className="px-4 pb-4 pt-2 shrink-0 flex gap-2">
					<button
						onClick={onClose}
						className="flex-1 border border-crease-line-bold text-graphite rounded-lg px-4 py-2 text-sm hover:border-crease transition-colors"
					>
						Cancel
					</button>
					<button
						onClick={() => void handleSubmit()}
						disabled={submitting}
						className="flex-1 bg-crane text-white rounded-lg px-4 py-2 text-sm hover:bg-crane-dark disabled:opacity-50 transition-colors"
					>
						{submitting
							? 'Sending…'
							: selected.size > 0
								? `Send report with ${selected.size} message${selected.size === 1 ? '' : 's'}`
								: 'Send report'}
					</button>
				</div>
			</div>
		</div>
	);
}
