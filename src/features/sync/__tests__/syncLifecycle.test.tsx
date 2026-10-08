import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, create } from 'react-test-renderer';

import { SyncLifecycle } from '../SyncLifecycle';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const mockOrder: string[] = [];
let mockOwner: string | null = USER;
jest.mock('../../../auth/AuthProvider', () => ({
  useAuth: () => ({ supabase: { name: 'client' }, session: { user: { id: '11111111-1111-4111-8111-111111111111' } } }),
}));
jest.mock('../../../db/database', () => ({
  connectSync: jest.fn(async () => {
    mockOrder.push('connect');
  }),
  disconnectAndClearSync: jest.fn(async () => {
    mockOrder.push('clear');
  }),
}));
jest.mock('../localDataOwner', () => ({
  getLocalDataOwner: jest.fn(async () => mockOwner),
  setLocalDataOwner: jest.fn(async () => {
    mockOrder.push('owner');
  }),
}));
jest.mock('../../timer/notifications', () => ({
  cancelAllAlerts: jest.fn(async () => {
    mockOrder.push('alerts');
  }),
}));

async function mount(): Promise<void> {
  await act(async () => {
    create(<SyncLifecycle powersyncUrl="https://sync.example.com" />);
  });
  await act(async () => {
    for (let k = 0; k < 10; k += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  });
}

beforeEach(() => {
  mockOrder.length = 0;
  jest.clearAllMocks();
});

describe('SyncLifecycle', () => {
  it('the same account: connects and keeps everything (unsent writes, the running cycle and its alert)', async () => {
    mockOwner = USER;
    await mount();
    expect(mockOrder).toEqual(['connect']);
  });

  it("another account's data on the phone: its alerts are withdrawn and its rows cleared before connecting", async () => {
    mockOwner = OTHER;
    await mount();
    expect(mockOrder).toEqual(['alerts', 'clear', 'owner', 'connect']);
  });
});
