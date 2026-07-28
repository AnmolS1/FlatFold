import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { isNativePlatform } from './lib/platform';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
import { ToastProvider } from './contexts/ToastContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { Login } from './pages/Login';

// Login stays in the entry chunk — it's the first thing an unauthenticated
// visitor renders. Everything behind it is split off: the chat surface pulls in
// the ratchet, HPKE, the search index and the QR encoder, none of which a
// visitor sitting on the login screen needs. Split chunks land in
// dist/client/assets/, which gen-sw-manifest.mjs pins wholesale, so they keep
// the same app-shell integrity guarantee as the entry bundle.
const Chat = lazy(() => import('./pages/Chat').then((m) => ({ default: m.Chat })));
import { ExperimentAudio } from './components/debug/ExperimentAudio';
import { useDebugRemountKey } from './components/debug/useDebugRemountKey';

const Transparency = lazy(() => import('./pages/Transparency').then((m) => ({ default: m.Transparency })));

function App() {
	// DEBUG-only: lets a probe force the conversation view to remount.
	const debugRemountKey = useDebugRemountKey();
	// Mark the document as the native shell so native-only CSS applies (e.g.
	// disabling the long-press text-selection callout). Set in an effect so the
	// Capacitor bridge is guaranteed attached.
	useEffect(() => {
		if (!isNativePlatform()) return;
		document.documentElement.classList.add('capacitor-native');
		// Register the content-free push → decoy local-notification handler, and
		// reconcile the APNs token with the current server (re-registers after a
		// backend switch) if the user has push enabled (Step 5).
		void import('./lib/nativePush').then((m) => {
			void m.initNativePushDisplay();
			void m.reconcileApnsSubscription();
		});
	}, []);

	return (
		// Outermost, so a throw in a provider or the router still shows something
		// recoverable rather than a blank document.
		<ErrorBoundary>
			{/* DEBUG-only scaffolding for the Mac audio experiment. Renders
			    nothing unless a probe asks and __flatfoldDebug is set, so it is
			    inert on web and absent from TestFlight and the App Store. */}
			<ExperimentAudio />
			<ThemeProvider>
				<ToastProvider>
					<BrowserRouter>
						<AuthProvider>
							<Suspense fallback={<div className="min-h-dvh bg-graph" aria-busy="true" aria-label="Loading" />}>
								<Routes>
								<Route path="/login" element={<Login />} />
								<Route path="/transparency" element={<Transparency />} />
								<Route
									path="/chat"
									element={
										<ProtectedRoute>
											{/* A second boundary around the conversation itself: a
											    render error in one message leaves the rest of the app
											    mounted, so you can still reach the UI that would
											    delete it. */}
											<ErrorBoundary>
												<Chat key={debugRemountKey} />
											</ErrorBoundary>
										</ProtectedRoute>
									}
								/>
								<Route path="/" element={<Navigate to="/chat" replace />} />
									<Route path="*" element={<Navigate to="/chat" replace />} />
								</Routes>
							</Suspense>
						</AuthProvider>
					</BrowserRouter>
				</ToastProvider>
			</ThemeProvider>
		</ErrorBoundary>
	);
}

export default App;
