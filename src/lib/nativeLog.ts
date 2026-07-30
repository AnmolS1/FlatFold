// A route from the web layer to the native system log.
//
// `console.log` inside WKWebView does not appear in the Xcode console. That gap
// shaped a whole debugging round: every measurement taken was native, so the
// JavaScript side went unmeasured across several device rebuilds — while the
// symptom (`WebProcessProxy::didBecomeUnresponsive`, which is the WEB main
// thread missing its watchdog) pointed at JavaScript the entire time.
//
// No-ops everywhere except a native DEBUG build, and never throws: this is
// instrumentation and must not be able to break the thing it measures.

/** True only in a native DEBUG build; MainViewController injects it. */
function debugEnabled(): boolean {
	return (globalThis as unknown as { __flatfoldDebug?: boolean }).__flatfoldDebug === true;
}

interface LogPlugin {
	debugLog?: (opts: { message: string }) => Promise<void>;
}

function plugin(): LogPlugin | undefined {
	return (globalThis as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor?.Plugins
		?.FlatFoldAudio as LogPlugin | undefined;
}

/** Send one line to os_log. Fire-and-forget. */
export function nativeLog(message: string): void {
	if (!debugEnabled()) return;
	try {
		void plugin()?.debugLog?.({ message })?.catch?.(() => {});
	} catch {
		/* instrumentation must never throw */
	}
}

/** Time an async step and report how long it took. */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
	// Skip the clock entirely when nothing will be reported — this wraps the
	// per-note decode path and runs on every platform.
	if (!debugEnabled()) return fn();
	const t0 = performance.now();
	try {
		return await fn();
	} finally {
		nativeLog(`${label} took ${Math.round(performance.now() - t0)}ms`);
	}
}
