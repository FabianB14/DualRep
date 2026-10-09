/**
 * Smoke tests for the F2 screens on the states a phone really starts in: an empty local database
 * (no profile row yet, no setups, no custom presets, no history) and offline. Each screen must render
 * something useful, offer its one main action, and never need the network. The local database is
 * replaced by a stub that answers watched queries from `mockRows` (empty unless a test fills it).
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ComponentType } from 'react';
import { Alert, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { SYSTEM_PRESET_IDS } from '@/db/constants';
import { STARTER_LIBRARY } from '@/features/training/starterLibrary';
import { ThemeProvider } from '@/theme';

const USER = '11111111-1111-4111-8111-111111111111';

/** Rows the stubbed useQuery returns for SQL matching each pattern (first match wins). */
const mockRows: [RegExp, unknown[]][] = [];
jest.mock('@powersync/react-native', () => ({
  useQuery: (sql: string) => ({ data: mockRows.find(([pattern]) => pattern.test(sql))?.[1] ?? [], isLoading: false }),
  useStatus: () => ({
    connected: false,
    connecting: false,
    lastSyncedAt: undefined,
    dataFlowStatus: { uploading: false, downloading: false, uploadError: undefined, downloadError: undefined },
  }),
  usePowerSync: () => ({ getUploadQueueStats: async () => ({ count: 0 }) }),
}));
jest.mock('../../db/database', () => ({ db: {} }));
const mockWaitForUploads = jest.fn(async (_timeoutMs: number) => 0);
jest.mock('../../db/syncCheck', () => ({ getUploadQueueCount: async () => 0, waitForUploads: mockWaitForUploads }));
const mockSignOut = jest.fn(async () => undefined);
jest.mock('../../auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: USER, email: 'sam@example.com' }, signOut: mockSignOut, offlineSession: false }),
}));
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn() };
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: mockRouter,
  useLocalSearchParams: () => mockParams,
  Stack: { Screen: () => null },
}));
const mockCancelAllAlerts = jest.fn(async () => undefined);
jest.mock('../../features/timer/notifications', () => ({
  cancelAllAlerts: mockCancelAllAlerts,
  getNotificationPermission: async () => 'undetermined',
  requestNotificationPermission: async () => 'granted',
  readAlertTestResult: async () => ({ status: 'none' }),
  scheduleAlertTest: async () => null,
}));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => undefined),
  selectionAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  performAndroidHapticsAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  AndroidHaptics: {},
}));

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 24, left: 0, right: 0, bottom: 16 } };

/** The screen module's default export (loaded after the mocks above). */
function screen(path: string): ComponentType {
  return (jest.requireActual(path) as { default: ComponentType }).default;
}

/** Rendered screens, unmounted after each test so their intervals (sync status, today) stop. */
const mounted: ReactTestRenderer[] = [];

async function render(Screen: ComponentType): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>
          <Screen />
        </ThemeProvider>
      </SafeAreaProvider>,
    );
  });
  mounted.push(renderer!);
  return renderer!;
}

function textOf(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => (node.type as unknown) === 'Text')
    .map((node) => [node.props.children].flat().filter((c: unknown) => typeof c === 'string' || typeof c === 'number').join(''))
    .join(' | ');
}

function control(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  return renderer.root.find(
    (node) => typeof node.type === 'string' && node.props.accessibilityLabel === label && typeof node.props.onClick === 'function',
  );
}

beforeEach(() => {
  mockRows.length = 0;
  mockParams = {};
  jest.clearAllMocks();
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) act(() => renderer.unmount());
});

describe('Home', () => {
  it('works with an empty database: defaults, today at zero, the two actions and every link', async () => {
    const renderer = await render(screen('../../app/(app)/index'));
    const text = textOf(renderer);
    expect(text).toContain('Today');
    expect(text).toContain('25 min');
    expect(text).toContain('Full body');
    expect(text).toContain('None yet');
    for (const link of ['Setups', 'Presets', 'Exercise library', 'History', 'Settings', 'Sync check', 'Timer check']) {
      expect(text).toContain(link);
    }
    act(() => control(renderer, 'Start a study block').props.onClick({}));
    expect(mockRouter.push).toHaveBeenLastCalledWith('/cycle');
    act(() => control(renderer, 'Just train').props.onClick({}));
    expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: '/cycle', params: { mode: 'move' } });
  });

  it('shows the saved defaults', async () => {
    mockRows.push(
      [/FROM profiles/, [{ id: USER, unit_pref: 'kg', default_block_minutes: 40, default_preset_id: SYSTEM_PRESET_IDS.all_upper, default_setup_id: 'g1' }]],
      [/FROM equipment_setups/, [{ id: 'h1', name: 'Home', location: 'home', equipment: '[]' }, { id: 'g1', name: 'City gym', location: 'gym', equipment: '["barbell"]' }]],
    );
    const text = textOf(await render(screen('../../app/(app)/index')));
    expect(text).toContain('40 min');
    expect(text).toContain('All upper body');
    expect(text).toContain('City gym');
  });
});

describe('Settings', () => {
  it('before the profile has synced: defaults shown, changes not offered, sign-out still there', async () => {
    const renderer = await render(screen('../../app/(app)/settings'));
    const text = textOf(renderer);
    expect(text).toContain('Not synced yet');
    expect(text).toContain('25 min');
    expect(control(renderer, 'Increase Default block length').props.accessibilityState).toEqual({ disabled: true });
    expect(text).toContain('Signed in as sam@example.com');
    expect(text).toContain('Not set up');
    expect(control(renderer, 'Sign out')).toBeDefined();
  });

  it('with a synced profile the controls are live', async () => {
    mockRows.push([/FROM profiles/, [{ id: USER, unit_pref: 'lb', default_block_minutes: 25 }]]);
    const renderer = await render(screen('../../app/(app)/settings'));
    expect(textOf(renderer)).not.toContain('Not synced yet');
    expect(control(renderer, 'Increase Default block length').props.accessibilityState).toEqual({ disabled: false });
  });

  it('signing out stops the running cycle, withdraws its alerts and lets its last writes upload before the data is cleared', async () => {
    const order: string[] = [];
    mockCancelAllAlerts.mockImplementationOnce(async () => {
      order.push('alerts withdrawn');
    });
    mockWaitForUploads.mockImplementationOnce(async () => {
      order.push('uploads sent');
      return 0;
    });
    mockSignOut.mockImplementationOnce(async () => {
      order.push('signed out');
    });
    const confirm = jest
      .spyOn(Alert, 'alert')
      .mockImplementation((_title: string, _message?: string, buttons?: AlertButton[]) => buttons?.[1]?.onPress?.());
    const renderer = await render(screen('../../app/(app)/settings'));
    await act(async () => {
      control(renderer, 'Sign out').props.onClick({});
      for (let k = 0; k < 10; k += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['alerts withdrawn', 'uploads sent', 'signed out']);
    confirm.mockRestore();
  });
});

describe('Setups', () => {
  it('offers one-tap templates when there are none', async () => {
    const text = textOf(await render(screen('../../app/(app)/setups/index')));
    expect(text).toContain('Home, just my body');
    expect(text).toContain('Gym');
    expect(text).toContain('Add a setup');
  });

  it('opens a blank editor for a new setup with the gear checklist', async () => {
    mockParams = { id: 'new' };
    const renderer = await render(screen('../../app/(app)/setups/[id]'));
    const text = textOf(renderer);
    expect(text).toContain('Gear here');
    expect(text).toContain('Dumbbells');
    expect(control(renderer, 'Dumbbells').props.accessibilityRole).toBe('checkbox');
    expect(text).toContain('Save setup');
  });

  it('says so when a setup is not on the phone', async () => {
    mockParams = { id: 'missing' };
    expect(textOf(await render(screen('../../app/(app)/setups/[id]')))).toContain('Setup not found');
  });
});

describe('Presets', () => {
  it('lists the six system presets before the first sync, Full body chosen', async () => {
    const renderer = await render(screen('../../app/(app)/presets/index'));
    const text = textOf(renderer);
    for (const name of ['All lower body', 'Mostly lower body', 'Full body', 'Mostly upper body', 'All upper body', 'Mostly cardio']) {
      expect(text).toContain(name);
    }
    const fullBody = renderer.root.find(
      (node) => typeof node.type === 'string' && node.props.accessibilityRole === 'radio' && String(node.props.accessibilityLabel).startsWith('Full body,'),
    );
    expect(fullBody.props.accessibilityState).toMatchObject({ checked: true });
  });

  it('the split editor needs 100% before it saves', async () => {
    mockParams = { id: 'new', from: SYSTEM_PRESET_IDS.mostly_cardio };
    const renderer = await render(screen('../../app/(app)/presets/[id]'));
    expect(textOf(renderer)).toContain('Total 100%. Ready to save.');
    act(() => control(renderer, 'Increase Cardio').props.onClick({}));
    expect(textOf(renderer)).toContain('Total 105%. Take away 5%.');
    expect(control(renderer, 'Save preset').props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('opens a system preset read-only, with a way to copy it', async () => {
    mockParams = { id: SYSTEM_PRESET_IDS.full_body };
    const renderer = await render(screen('../../app/(app)/presets/[id]'));
    expect(textOf(renderer)).toContain('can’t be changed');
    act(() => control(renderer, 'Copy as a custom split').props.onClick({}));
    expect(mockRouter.replace).toHaveBeenCalledWith({
      pathname: '/presets/[id]',
      params: { id: 'new', from: SYSTEM_PRESET_IDS.full_body },
    });
  });
});

describe('Library', () => {
  it('shows the bundled starter library offline', async () => {
    const renderer = await render(screen('../../app/(app)/library/index'));
    expect(textOf(renderer)).toContain(`${STARTER_LIBRARY.length} exercises`);
    expect(control(renderer, 'Fits my setup').props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('shows a starter exercise with its steps', async () => {
    const exercise = STARTER_LIBRARY[0];
    mockParams = { id: exercise.id };
    const text = textOf(await render(screen('../../app/(app)/library/[id]')));
    expect(text).toContain(exercise.name);
    expect(text).toContain(exercise.instructions[0]);
    expect(text).toContain('DualRep original');
  });

  it('the add form explains what is missing', async () => {
    const renderer = await render(screen('../../app/(app)/library/new'));
    await act(async () => control(renderer, 'Save exercise').props.onClick({}));
    const text = textOf(renderer);
    expect(text).toContain('Give it a name.');
    expect(text).toContain('Pick the kind of movement.');
  });
});

describe('History', () => {
  it('has friendly empty states', async () => {
    const renderer = await render(screen('../../app/(app)/history'));
    expect(textOf(renderer)).toContain('No workouts yet');
    act(() => control(renderer, 'Focus blocks').props.onClick({}));
    expect(textOf(renderer)).toContain('No focus blocks yet');
  });
});

describe('Timer check', () => {
  it('starts with no test and the steps to run one', async () => {
    const text = textOf(await render(screen('../../app/(app)/timer-check')));
    expect(text).toContain('No test yet');
    expect(text).toContain('How to run it');
    expect(text).toContain('Schedule test alert');
  });
});
