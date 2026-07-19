import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount between tests so focus assertions can't be satisfied by a leftover
// tree from a previous test.
afterEach(cleanup);
