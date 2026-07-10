import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
import { ToastProvider } from './contexts/ToastContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Login } from './pages/Login';
import { Chat } from './pages/Chat';
import { Transparency } from './pages/Transparency';

function App() {
	return (
		<ThemeProvider>
			<ToastProvider>
				<BrowserRouter>
					<AuthProvider>
						<Routes>
							<Route path="/login" element={<Login />} />
							<Route path="/transparency" element={<Transparency />} />
							<Route
								path="/chat"
								element={
									<ProtectedRoute>
										<Chat />
									</ProtectedRoute>
								}
							/>
							<Route path="/" element={<Navigate to="/chat" replace />} />
							<Route path="*" element={<Navigate to="/chat" replace />} />
						</Routes>
					</AuthProvider>
				</BrowserRouter>
			</ToastProvider>
		</ThemeProvider>
	);
}

export default App;
