import { registerPlugin } from '@capacitor/core';
import { isNativePlatform } from './platform';

// Bridge to the custom FlatFoldAppIcon native plugin (manual alternate-icon
// picker). iOS shows a confirmation alert on every change, so this is only ever
// called from an explicit Settings tap — never auto-switched with the theme.
export interface FlatFoldAppIconPlugin {
	isSupported(): Promise<{ supported: boolean }>;
	getIcon(): Promise<{ name: string }>;
	setIcon(options: { name: string }): Promise<void>;
}

const plugin = registerPlugin<FlatFoldAppIconPlugin>('FlatFoldAppIcon');

// 'default' = the primary asset-catalog icon (which already does light/dark).
export type AppIconName = 'default' | 'Vellum' | 'Graphite' | 'Midnight';

export async function appIconSupported(): Promise<boolean> {
	if (!isNativePlatform()) return false;
	try {
		return (await plugin.isSupported()).supported;
	} catch {
		return false;
	}
}

export async function getAppIcon(): Promise<AppIconName> {
	try {
		return ((await plugin.getIcon()).name as AppIconName) ?? 'default';
	} catch {
		return 'default';
	}
}

export async function setAppIcon(name: AppIconName): Promise<void> {
	await plugin.setIcon({ name });
}
