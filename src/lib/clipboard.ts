// Copy text to the clipboard, best-effort. Prefers the async Clipboard API
// (works in the capacitor://localhost secure context and modern browsers); falls
// back to a hidden-textarea execCommand for older/edge webviews. Returns whether
// it succeeded so the caller can confirm or fall back to long-press-copy.
export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// fall through to the legacy path
	}
	try {
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.style.position = 'fixed';
		ta.style.top = '0';
		ta.style.opacity = '0';
		document.body.appendChild(ta);
		ta.focus();
		ta.select();
		const ok = document.execCommand('copy');
		document.body.removeChild(ta);
		return ok;
	} catch {
		return false;
	}
}
