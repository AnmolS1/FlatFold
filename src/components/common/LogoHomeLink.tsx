import { Link } from 'react-router-dom';
import { LogoWordmark } from './Brand';
import { useAuth } from '../../hooks/useAuth';

// The header wordmark, made a home link: /chat when signed in, /login otherwise
// (same auth check ProtectedRoute uses — `username` present ⇒ signed in). Kept
// keyboard-focusable with a visible focus ring and an explicit aria-label, since
// the wordmark itself is an SVG with no intrinsic link semantics.
export const LogoHomeLink = ({ height = 40 }: { height?: number }) => {
	const { username } = useAuth();
	return (
		<Link
			to={username ? '/chat' : '/login'}
			aria-label="FlatFold home"
			className="inline-flex rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-crease"
		>
			<LogoWordmark height={height} />
		</Link>
	);
};
