import { describe, expect, it } from 'vitest';
import { assetDigest, verifyShellAsset } from '../src/sw/shellIntegrity';

// The security-critical core of the service-worker app-shell integrity pin (H1).
// The SW's browser glue (Cache API, clients.postMessage, fetch events) can't run
// in this workerd test harness, so the *decision* logic lives here and is tested;
// public/sw.js inlines the same algorithm and wires it to the fetch handler.

const bytes = (s: string) => new TextEncoder().encode(s);

describe('shell-integrity pin', () => {
	it('assetDigest is a stable sha256-<base64> over the bytes', async () => {
		const d = await assetDigest(bytes('hello'));
		expect(d).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
		// SHA-256("hello") base64 = LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=
		expect(d).toBe('sha256-LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=');
	});

	it('accepts an asset whose bytes match the pinned digest', async () => {
		const content = bytes('console.log(1)');
		const manifest = { '/assets/app.js': await assetDigest(content) };
		expect(await verifyShellAsset('/assets/app.js', content, manifest)).toEqual({ pinned: true, ok: true });
	});

	it('rejects (does not verify) an asset whose bytes DIFFER from the pin', async () => {
		const manifest = { '/assets/app.js': await assetDigest(bytes('console.log(1)')) };
		const tampered = bytes('console.log(1);fetch("//evil")');
		expect(await verifyShellAsset('/assets/app.js', tampered, manifest)).toEqual({ pinned: true, ok: false });
	});

	it('treats an asset not in the manifest as unpinned (cache as before)', async () => {
		const manifest = { '/assets/app.js': await assetDigest(bytes('x')) };
		expect(await verifyShellAsset('/assets/other.js', bytes('anything'), manifest)).toEqual({ pinned: false, ok: true });
	});

	it('an empty manifest (dev / not injected) pins nothing', async () => {
		expect(await verifyShellAsset('/assets/app.js', bytes('anything'), {})).toEqual({ pinned: false, ok: true });
	});
});
