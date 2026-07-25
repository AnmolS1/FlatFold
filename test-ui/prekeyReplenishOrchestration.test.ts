// The replenishment decision + ordering, with the keystore and API mocked so the
// sequencing is observable.
//
// The invariant that matters most: if persisting the new secrets locally fails,
// NOTHING may be published. Publishing a prekey whose secret we never stored
// would leave a key on the server that we cannot complete a handshake with, and
// the server deletes each prekey on use, so the first contact that claimed it
// would break with no way back.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	apiGetPreKeyCount: vi.fn(),
	apiAddOneTimePreKeys: vi.fn(),
	addOneTimePreKeys: vi.fn(),
}));

vi.mock('../src/lib/api', () => ({
	apiGetPreKeyCount: mocks.apiGetPreKeyCount,
	apiAddOneTimePreKeys: mocks.apiAddOneTimePreKeys,
}));
vi.mock('../src/keystore', () => ({ addOneTimePreKeys: mocks.addOneTimePreKeys }));

import { replenishPreKeysIfLow, __resetReplenishStateForTests } from '../src/lib/prekeyReplenish';

beforeEach(() => {
	vi.clearAllMocks();
	__resetReplenishStateForTests();
	mocks.apiAddOneTimePreKeys.mockResolvedValue(undefined);
});

describe('replenishPreKeysIfLow', () => {
	it('does nothing while the pool is healthy', async () => {
		mocks.apiGetPreKeyCount.mockResolvedValue(20);
		await replenishPreKeysIfLow('alice');
		expect(mocks.addOneTimePreKeys).not.toHaveBeenCalled();
		expect(mocks.apiAddOneTimePreKeys).not.toHaveBeenCalled();
	});

	it('tops the pool back up to the target when it has run low', async () => {
		mocks.apiGetPreKeyCount.mockResolvedValue(3);
		mocks.addOneTimePreKeys.mockResolvedValue(['k1', 'k2']);

		await replenishPreKeysIfLow('alice');

		// 3 remaining against a target of 20 ⇒ ask for 17.
		expect(mocks.addOneTimePreKeys).toHaveBeenCalledWith('alice', 17);
		expect(mocks.apiAddOneTimePreKeys).toHaveBeenCalledWith(['k1', 'k2']);
	});

	it('refills an emptied pool', async () => {
		mocks.apiGetPreKeyCount.mockResolvedValue(0);
		mocks.addOneTimePreKeys.mockResolvedValue(['a']);
		await replenishPreKeysIfLow('alice');
		expect(mocks.addOneTimePreKeys).toHaveBeenCalledWith('alice', 20);
	});

	it('PUBLISHES NOTHING if persisting the secrets locally fails', async () => {
		mocks.apiGetPreKeyCount.mockResolvedValue(0);
		mocks.addOneTimePreKeys.mockRejectedValue(new Error('keystore write failed'));

		await replenishPreKeysIfLow('alice'); // must not throw

		expect(mocks.apiAddOneTimePreKeys).not.toHaveBeenCalled();
	});

	it('persists locally BEFORE publishing (call order)', async () => {
		const order: string[] = [];
		mocks.apiGetPreKeyCount.mockResolvedValue(0);
		mocks.addOneTimePreKeys.mockImplementation(async () => {
			order.push('persist');
			return ['k'];
		});
		mocks.apiAddOneTimePreKeys.mockImplementation(async () => {
			order.push('publish');
		});

		await replenishPreKeysIfLow('alice');
		expect(order).toEqual(['persist', 'publish']);
	});

	it('stays quiet when the count lookup fails (offline)', async () => {
		mocks.apiGetPreKeyCount.mockRejectedValue(new Error('offline'));
		await expect(replenishPreKeysIfLow('alice')).resolves.toBeUndefined();
		expect(mocks.addOneTimePreKeys).not.toHaveBeenCalled();
	});

	it('does not re-ask the server on every mount once it has checked', async () => {
		mocks.apiGetPreKeyCount.mockResolvedValue(20);
		await replenishPreKeysIfLow('alice');
		await replenishPreKeysIfLow('alice');
		await replenishPreKeysIfLow('alice');
		expect(mocks.apiGetPreKeyCount).toHaveBeenCalledTimes(1);
	});

	it('does not start a cooldown when the read FAILED (offline stays retryable)', async () => {
		mocks.apiGetPreKeyCount.mockRejectedValueOnce(new Error('offline'));
		await replenishPreKeysIfLow('alice');
		mocks.apiGetPreKeyCount.mockResolvedValue(0);
		mocks.addOneTimePreKeys.mockResolvedValue(['k']);

		await replenishPreKeysIfLow('alice'); // must actually retry
		expect(mocks.apiGetPreKeyCount).toHaveBeenCalledTimes(2);
		expect(mocks.addOneTimePreKeys).toHaveBeenCalled();
	});

	it('de-dupes concurrent callers into one refill', async () => {
		mocks.apiGetPreKeyCount.mockResolvedValue(0);
		mocks.addOneTimePreKeys.mockResolvedValue(['k']);

		await Promise.all([replenishPreKeysIfLow('alice'), replenishPreKeysIfLow('alice'), replenishPreKeysIfLow('alice')]);

		expect(mocks.apiGetPreKeyCount).toHaveBeenCalledTimes(1);
		expect(mocks.addOneTimePreKeys).toHaveBeenCalledTimes(1);
	});
});
