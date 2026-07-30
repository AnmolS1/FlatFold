import { registerPlugin } from '@capacitor/core';
import { isNativePlatform } from './platform';

// Bridge to the custom native FlatFoldBiometric plugin (ios/App/App/
// FlatFoldBiometricPlugin.swift). The secret (the keystore master key) lives in a
// Secure-Enclave-gated Keychain item; getSecret triggers the OS Face ID sheet and
// resolves only on a live biometric match. No-ops / unavailable off native.
export interface FlatFoldBiometricPlugin {
	isAvailable(): Promise<{ available: boolean; biometryType: string }>;
	hasSecret(options: { key: string }): Promise<{ enrolled: boolean }>;
	setSecret(options: { key: string; value: string }): Promise<void>;
	getSecret(options: { key: string; reason?: string }): Promise<{ value: string }>;
	deleteSecret(options: { key: string }): Promise<void>;
}

const plugin = registerPlugin<FlatFoldBiometricPlugin>('FlatFoldBiometric');

export interface BiometricAvailability {
	available: boolean;
	biometryType: string; // 'faceId' | 'touchId' | 'unknown' | 'none'
}

/**
 * What to CALL the biometric on this device, in UI text.
 *
 * Never hardcode "Face ID". The same build runs on iPhone (Face ID), older
 * iPhones and Macs (Touch ID), and Mac Catalyst — where a Mac without Touch ID
 * falls back to the watch or the device password entirely. `LAContext
 * .biometryType` is the only thing that knows, and the plugin already reports
 * it; the unlock gate simply was not asking, so a Mac was told to use Face ID.
 *
 * Falls back to "biometrics" rather than guessing, which reads acceptably in
 * every sentence it appears in.
 */
export function biometryLabel(biometryType: string): string {
	if (biometryType === 'faceId') return 'Face ID';
	if (biometryType === 'touchId') return 'Touch ID';
	return 'biometrics';
}

export async function biometricAvailable(): Promise<BiometricAvailability> {
	if (!isNativePlatform()) return { available: false, biometryType: 'none' };
	try {
		return await plugin.isAvailable();
	} catch {
		return { available: false, biometryType: 'none' };
	}
}

export async function biometricHasSecret(key: string): Promise<boolean> {
	if (!isNativePlatform()) return false;
	try {
		return (await plugin.hasSecret({ key })).enrolled;
	} catch {
		return false;
	}
}

export async function biometricSetSecret(key: string, value: string): Promise<void> {
	await plugin.setSecret({ key, value });
}

// Returns the secret on a successful Face ID match, or null on cancel/failure/absent.
export async function biometricGetSecret(key: string, reason: string): Promise<string | null> {
	try {
		return (await plugin.getSecret({ key, reason })).value;
	} catch {
		return null;
	}
}

export async function biometricDeleteSecret(key: string): Promise<void> {
	if (!isNativePlatform()) return;
	try {
		await plugin.deleteSecret({ key });
	} catch {
		// best-effort
	}
}
