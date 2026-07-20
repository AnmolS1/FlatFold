import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
// The keystore is built directly on IndexedDB, which jsdom doesn't implement.
// fake-indexeddb gives these tests a real (in-memory) IndexedDB, so keystore
// behavior is exercised for real rather than mocked — the session-record bugs
// worth catching only show up across a save/load round trip.
import 'fake-indexeddb/auto';

// Unmount between tests so focus assertions can't be satisfied by a leftover
// tree from a previous test.
afterEach(cleanup);
