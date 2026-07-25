// The privacy + gating contract for web tab notifications. The title/favicon dot
// is cosmetic and browser-verified; what matters here is that a browser
// notification is CONTENT-FREE and only ever fires when it should — never leaking
// a sender or message text, never without permission, never on native, never
// while the user is already looking at the tab.
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/platform', () => ({ isNativePlatform: vi.fn(() => false) }));
vi.mock('../src/lib/push', () => ({ getDecoyLabel: () => 'New activity' }));

import { surfaceInboundActivity, notifyActivity } from '../src/lib/webNotify';
import { isNativePlatform } from '../src/lib/platform';

interface FakeNotification {
	title: string;
	options?: NotificationOptions;
}
let instances: FakeNotification[] = [];

class MockNotification {
	static permission: NotificationPermission = 'granted';
	onclick: (() => void) | null = null;
	title: string;
	options?: NotificationOptions;
	constructor(title: string, options?: NotificationOptions) {
		this.title = title;
		this.options = options;
		instances.push({ title, options });
	}
	close() {}
}

beforeEach(() => {
	instances = [];
	vi.stubGlobal('Notification', MockNotification);
	MockNotification.permission = 'granted';
	vi.spyOn(document, 'hasFocus').mockReturnValue(false); // tab NOT focused
	vi.mocked(isNativePlatform).mockReturnValue(false); // web
});

describe('webNotify — content-free notification contract', () => {
	it('fires a notification with only the decoy label and NO body when web + unfocused + granted', () => {
		surfaceInboundActivity();
		expect(instances).toHaveLength(1);
		expect(instances[0].title).toBe('New activity'); // decoy label, not a sender or text
		expect(instances[0].options?.body).toBeUndefined(); // never leaks message content
	});

	it('does NOT notify without granted permission', () => {
		MockNotification.permission = 'denied';
		surfaceInboundActivity();
		expect(instances).toHaveLength(0);
	});

	it('does NOT notify on native (APNs handles it)', () => {
		vi.mocked(isNativePlatform).mockReturnValue(true);
		surfaceInboundActivity();
		expect(instances).toHaveLength(0);
	});

	it('does NOT notify when the tab is focused (the message is already on screen)', () => {
		vi.spyOn(document, 'hasFocus').mockReturnValue(true);
		surfaceInboundActivity();
		expect(instances).toHaveLength(0);
	});

	it('notifyActivity is content-free even when called directly', () => {
		notifyActivity();
		expect(instances).toHaveLength(1);
		expect(instances[0].title).toBe('New activity');
		expect(instances[0].options?.body).toBeUndefined();
	});
});
