// The microphone "just failed" on Mac for several rounds, and the reason nobody
// could tell WHY is one line in MessageInput:
//
//     } catch { setError('Could not access the microphone.'); }
//
// A bare catch, discarding the error. getUserMedia rejects with a DOMException
// whose `.name` names the failure exactly — NotAllowedError is a permission
// problem, NotFoundError is no device, NotReadableError is the device being held
// by something else — and all of that was being thrown away. Speculation about
// sandbox entitlements filled the vacuum for five rounds.
//
// Same lesson as the voice-note "Error" bug: say WHY, and name the thing, so a
// bug report is diagnosable without a rebuild.
import { describe, expect, it } from 'vitest';
import { describeMicrophoneError } from '../src/lib/mediaErrors';

const domError = (name: string) => new DOMException('boom', name);

describe('describeMicrophoneError', () => {
	it('names a permission denial and says where to grant it, per platform', () => {
		const onMac = describeMicrophoneError(domError('NotAllowedError'), true);
		expect(onMac).toMatch(/System Settings/);
		expect(onMac).toMatch(/Microphone/);

		const onPhone = describeMicrophoneError(domError('NotAllowedError'), false);
		expect(onPhone).not.toMatch(/System Settings/); // that is the Mac path
		expect(onPhone).toMatch(/Settings/);
	});

	it('distinguishes no-device from permission', () => {
		expect(describeMicrophoneError(domError('NotFoundError'), false)).toMatch(/no microphone/i);
	});

	it('distinguishes a busy device, which is not a permission problem', () => {
		expect(describeMicrophoneError(domError('NotReadableError'), false)).toMatch(/another app|in use/i);
	});

	// The whole point: whatever happens, the report must carry the name.
	it.each(['NotAllowedError', 'NotFoundError', 'NotReadableError', 'SecurityError', 'WeirdFutureError'])(
		'always includes the error name (%s) so a screenshot is diagnosable',
		(name) => {
			expect(describeMicrophoneError(domError(name), false)).toContain(name);
		}
	);

	it('survives a non-Error rejection without throwing', () => {
		expect(() => describeMicrophoneError('nope', false)).not.toThrow();
		expect(describeMicrophoneError(undefined, false)).toBeTruthy();
	});
});

describe('the component actually uses it', () => {
	// A passing unit test proves nothing if MessageInput still swallows the error.
	// Same guard as audioFormat's — that lesson cost a regression once already.
	it('MessageInput reports the real error instead of a bare catch', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const src = readFileSync(resolve(process.cwd(), 'src/components/chat/MessageInput.tsx'), 'utf8');
		expect(src).toContain('describeMicrophoneError');
		// The parameterless `catch {` that discarded the diagnosis must be gone.
		expect(src).not.toMatch(/catch\s*\{\s*setError\('Could not access the microphone\.'\)/);
	});
});
