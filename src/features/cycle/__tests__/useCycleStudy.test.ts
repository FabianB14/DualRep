/**
 * The app's cycle store reschedules the daily review reminder after a study block, through the study
 * engine loaded on demand (useCycle.ts rescheduleReviewsAfterStudyBlock).
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { defaultCycleStoreDeps, rescheduleReviewsAfterStudyBlock } from '../useCycle';

jest.mock('@powersync/react-native', () => ({ useQuery: () => ({ data: [], isLoading: false }) }));
jest.mock('../../../db/database', () => ({ db: {} }));
jest.mock('../../../auth/AuthProvider', () => ({ useAuth: () => ({ user: null }) }));
jest.mock('../../training/useLibrary', () => ({ useLibrary: () => ({ circuitPool: [], byId: new Map() }) }));
jest.mock('../../timer/notifications', () => ({
  getNotificationPermission: jest.fn(async () => 'granted'),
  scheduleBlockEnd: jest.fn(async () => 'id'),
  cancelScheduled: jest.fn(async () => undefined),
  cancelAllAlerts: jest.fn(async () => undefined),
  registerVisibleTimer: jest.fn(() => () => undefined),
}));
jest.mock('../../../lib/ids', () => ({ newId: () => 'id' }));
jest.mock('../../study/hooks', () => ({ rescheduleReviewReminderNow: jest.fn(async () => undefined) }));

type AnyMock = jest.Mock<(...args: any[]) => any>;
const hooks = jest.requireMock('../../study/hooks') as { rescheduleReviewReminderNow: AnyMock };

const USER = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('rescheduleReviewsAfterStudyBlock', () => {
  it('is what the app’s store calls after a study block', () => {
    expect(defaultCycleStoreDeps().studyBlockEnded).toBe(rescheduleReviewsAfterStudyBlock);
  });

  it('reschedules the reminder for the user with this phone’s setting', () => {
    rescheduleReviewsAfterStudyBlock(USER);
    expect(hooks.rescheduleReviewReminderNow).toHaveBeenCalledWith(USER);
  });

  it('never throws or rejects', async () => {
    hooks.rescheduleReviewReminderNow.mockRejectedValueOnce(new Error('no permission'));
    expect(() => rescheduleReviewsAfterStudyBlock(USER)).not.toThrow();
    hooks.rescheduleReviewReminderNow.mockImplementationOnce(() => {
      throw new Error('no native module');
    });
    expect(() => rescheduleReviewsAfterStudyBlock(USER)).not.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});
