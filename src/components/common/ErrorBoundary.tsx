import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

// Without a boundary, one render error unmounts the whole tree — React's
// default. On a messenger that means a single malformed message takes the
// conversation, the contact list and the composer with it, including the UI
// you'd need to delete the message that caused it.
//
// Deliberately does NOT display the error text. On an E2EE app a thrown error
// can carry decrypted message content or key material in its message, and this
// screen is the one most likely to be photographed and sent to someone for
// help. The details go to the console for a developer with the device in hand;
// they never go on screen. (No remote error reporting either — shipping
// exception payloads off-device would undo the point of the product.)

interface Props {
	children: ReactNode;
	/** Shown instead of the default panel, e.g. to keep the chrome around a failed pane. */
	fallback?: (retry: () => void) => ReactNode;
}

interface State {
	failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
	state: State = { failed: false };

	static getDerivedStateFromError(): State {
		return { failed: true };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		// Console only, and only in development-facing form. Kept because a
		// stack is the single most useful thing when reproducing on a device.
		console.error('Render error caught by ErrorBoundary:', error, info.componentStack);
	}

	private retry = () => this.setState({ failed: false });

	render() {
		if (!this.state.failed) return this.props.children;
		if (this.props.fallback) return this.props.fallback(this.retry);

		return (
			<div role="alert" className="min-h-dvh flex items-center justify-center bg-graph p-6">
				<div className="max-w-sm w-full bg-graph-card border border-crease-line rounded-2xl p-6 text-center">
					<AlertTriangle className="w-8 h-8 text-crane mx-auto mb-3" aria-hidden="true" />
					<h1 className="font-display text-lg font-bold text-graphite mb-2">Something broke</h1>
					<p className="text-sm text-graphite-60 mb-5">
						This part of the app hit an error and stopped. Your messages and keys are stored on this device and are
						unaffected.
					</p>
					<div className="flex flex-col gap-2">
						{/* Retry first: re-rendering keeps anything typed but unsent, which
						    a full reload would throw away. */}
						<button
							onClick={this.retry}
							className="h-11 rounded-full bg-crane text-white font-medium hover:bg-crane-dark focus:outline-none focus:ring-2 focus:ring-crane focus:ring-offset-2"
						>
							Try again
						</button>
						<button
							onClick={() => window.location.reload()}
							className="h-11 rounded-full border border-crease-line-bold text-graphite hover:border-crease focus:outline-none focus:ring-2 focus:ring-crease"
						>
							Reload the app
						</button>
					</div>
				</div>
			</div>
		);
	}
}
