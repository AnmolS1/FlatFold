// `navigator.mediaDevices` is not always there, and when it is missing the old
// code did `navigator.mediaDevices.getUserMedia(...)` and threw a bare
// TypeError — which is exactly what the Mac reported: "(TypeError)". That is a
// capability problem, not a permission problem, and the two were being confused
// for several rounds.
//
// SafetyNumberDialog already knew this: it guards the QR scanner with
// `navigator.mediaDevices?.getUserMedia` and a `scanSupported` flag. The
// microphone path simply never got the same treatment.
//
// `mediaDevices` is exposed only in a SECURE CONTEXT, so the interesting
// question is which precondition is missing. These tests pin the reporting, so
// one run identifies it instead of another round of speculation.
import { describe, expect, it } from 'vitest';
import { readMediaEnvironment, microphoneUnavailableReason } from '../src/lib/mediaErrors';

const env = (over: Partial<ReturnType<typeof readMediaEnvironment>> = {}) => ({
	isSecureContext: true,
	hasMediaDevices: true,
	hasGetUserMedia: true,
	protocol: 'capacitor:',
	...over,
});

describe('microphoneUnavailableReason', () => {
	it('returns null when everything needed is present', () => {
		expect(microphoneUnavailableReason(env())).toBeNull();
	});

	it('names an insecure context, and the scheme, because that is the usual cause', () => {
		const reason = microphoneUnavailableReason(env({ isSecureContext: false, hasMediaDevices: false }));
		expect(reason).toMatch(/secure context/i);
		expect(reason).toContain('capacitor:'); // the scheme must be in the report
	});

	it('distinguishes "no mediaDevices at all" from "mediaDevices without getUserMedia"', () => {
		const missingAll = microphoneUnavailableReason(env({ hasMediaDevices: false }));
		const missingFn = microphoneUnavailableReason(env({ hasGetUserMedia: false }));
		expect(missingAll).not.toEqual(missingFn);
		expect(missingAll).toMatch(/mediaDevices/);
		expect(missingFn).toMatch(/getUserMedia/);
	});
});

describe('readMediaEnvironment', () => {
	it('reports a fully-capable environment', () => {
		const result = readMediaEnvironment(
			{ mediaDevices: { getUserMedia: () => {} } } as unknown as Navigator,
			{ isSecureContext: true, location: { protocol: 'https:' } } as unknown as Window
		);
		expect(result).toEqual({
			isSecureContext: true,
			hasMediaDevices: true,
			hasGetUserMedia: true,
			protocol: 'https:',
		});
	});

	// The Mac case: mediaDevices absent entirely.
	it('reports a missing mediaDevices without throwing', () => {
		const result = readMediaEnvironment(
			{} as unknown as Navigator,
			{ isSecureContext: false, location: { protocol: 'capacitor:' } } as unknown as Window
		);
		expect(result.hasMediaDevices).toBe(false);
		expect(result.hasGetUserMedia).toBe(false);
		expect(result.isSecureContext).toBe(false);
		expect(result.protocol).toBe('capacitor:');
	});
});

describe('the component actually preflights', () => {
	it('MessageInput checks availability before calling getUserMedia', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const src = readFileSync(resolve(process.cwd(), 'src/components/chat/MessageInput.tsx'), 'utf8');
		expect(src).toContain('microphoneUnavailableReason');
		// The preflight must come BEFORE the call that would throw the TypeError.
		expect(src.indexOf('microphoneUnavailableReason')).toBeLessThan(src.indexOf('getUserMedia'));
	});
});
