import { describe, expect, it } from 'vitest';
import { generateIdentityKeyPair } from './x3dh';
import { computeSafetyNumber, formatSafetyNumber, type SafetyNumberIdentity } from './safetyNumber';

function identityOf(username: string, keys = generateIdentityKeyPair()): SafetyNumberIdentity {
	return { username, signingPublicKey: keys.signing.publicKey, dhPublicKey: keys.dh.publicKey };
}

describe('safety number', () => {
	it('is symmetric — both parties compute the same number regardless of who is "self"', () => {
		const alice = identityOf('alice');
		const bob = identityOf('bob');

		expect(computeSafetyNumber(alice, bob)).toBe(computeSafetyNumber(bob, alice));
	});

	it('is a deterministic 60-digit number', () => {
		const alice = identityOf('alice');
		const bob = identityOf('bob');

		const number = computeSafetyNumber(alice, bob);
		expect(number).toMatch(/^\d{60}$/);
		expect(computeSafetyNumber(alice, bob)).toBe(number); // stable across calls
	});

	it('differs for different contacts', () => {
		const alice = identityOf('alice');
		const bob = identityOf('bob');
		const carol = identityOf('carol');

		expect(computeSafetyNumber(alice, bob)).not.toBe(computeSafetyNumber(alice, carol));
	});

	it('changes when the DH key changes (fingerprint commits to the DH key)', () => {
		const aliceKeys = generateIdentityKeyPair();
		const alice = identityOf('alice', aliceKeys);
		const bob = identityOf('bob');
		const before = computeSafetyNumber(alice, bob);

		// Same signing key, new DH key — the number MUST change, or an attacker
		// could swap the DH key undetected.
		const swappedDh: SafetyNumberIdentity = { ...alice, dhPublicKey: generateIdentityKeyPair().dh.publicKey };
		expect(computeSafetyNumber(swappedDh, bob)).not.toBe(before);
	});

	it('changes when the signing key changes (fingerprint commits to the signing key)', () => {
		const aliceKeys = generateIdentityKeyPair();
		const alice = identityOf('alice', aliceKeys);
		const bob = identityOf('bob');
		const before = computeSafetyNumber(alice, bob);

		// Same DH key, new signing key — must also change.
		const swappedSigning: SafetyNumberIdentity = { ...alice, signingPublicKey: generateIdentityKeyPair().signing.publicKey };
		expect(computeSafetyNumber(swappedSigning, bob)).not.toBe(before);
	});

	it('changes when the username changes (bound to identity, not just keys)', () => {
		const keys = generateIdentityKeyPair();
		const asAlice = identityOf('alice', keys);
		const asMallory = identityOf('mallory', keys);
		const bob = identityOf('bob');

		expect(computeSafetyNumber(asAlice, bob)).not.toBe(computeSafetyNumber(asMallory, bob));
	});

	it('formats as twelve space-separated groups of five digits', () => {
		const formatted = formatSafetyNumber(computeSafetyNumber(identityOf('alice'), identityOf('bob')));
		const groups = formatted.split(' ');
		expect(groups).toHaveLength(12);
		for (const group of groups) expect(group).toMatch(/^\d{5}$/);
	});
});
