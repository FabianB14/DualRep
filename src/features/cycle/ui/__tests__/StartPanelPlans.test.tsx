/**
 * The start panel's plan picker (Phase 2): "What are you studying?" picks a study plan or just a
 * timer, a cumulative plan also picks its cards, and the last choice is remembered on this phone.
 * The study hooks are replaced by plans given here; the rest of the database is empty (offline, no
 * profile, no setups yet), as on a phone before its first sync.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { StudyPlan } from '@/features/study/studyQueries';
import { PLAN_SOURCES_SQL } from '@/features/study/studyQueries';
import { STUDY_DEFAULTS_KEY } from '@/features/study/studyPrefs';
import { ThemeProvider } from '@/theme';

import type { CyclePlanInput } from '../../cycleMachine';
import { StartPanel } from '../StartPanel';

const mockRows = new Map<string, unknown[]>();
jest.mock('@powersync/react-native', () => ({
  useQuery: (sql: string) => ({ data: mockRows.get(sql) ?? [], isLoading: false }),
}));
jest.mock('../../../../db/database', () => ({ db: {} }));
jest.mock('../../../../auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: '11111111-1111-4111-8111-111111111111' } }),
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
jest.mock('../../../setups/setupsRepo', () => ({ createSetupFromTemplate: jest.fn(async () => 'setup-new') }));
const mockLocal = new Map<string, unknown>();
jest.mock('../../localState', () => ({
  useLocalState: (key: string) => ({ value: mockLocal.get(key) ?? null, isLoading: false }),
  readLocalState: jest.fn(async (key: string) => mockLocal.get(key) ?? null),
  writeLocalState: jest.fn(async () => undefined),
}));
let mockPlans: StudyPlan[] = [];
jest.mock('../../../study/hooks', () => ({ usePlans: () => ({ plans: mockPlans, isLoading: false }) }));

type AnyMock = jest.Mock<(...args: any[]) => any>;
const local = jest.requireMock('../../localState') as { writeLocalState: AnyMock };

const BIO = '90000000-0000-4000-8000-000000000001';
const CHEM = '90000000-0000-4000-8000-000000000002';
const EMPTY = '90000000-0000-4000-8000-000000000003';

function plan(overrides: Partial<StudyPlan>): StudyPlan {
  return {
    id: BIO,
    ownerId: '11111111-1111-4111-8111-111111111111',
    groupId: null,
    title: 'Biology 101',
    scope: 'cumulative',
    goal: '',
    targetDate: null,
    sourceCount: 2,
    cardCount: 40,
    dueCount: 12,
    newCount: 5,
    isOwner: true,
    ...overrides,
  };
}

const PLANS = [
  plan({}),
  plan({ id: CHEM, title: 'Organic chemistry', scope: 'single', sourceCount: 1, cardCount: 10, dueCount: 0, newCount: 10 }),
  plan({ id: EMPTY, title: 'History', scope: 'single', sourceCount: 1, cardCount: 0, dueCount: 0, newCount: 0 }),
];

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 24, left: 0, right: 0, bottom: 16 } };
const mounted: ReactTestRenderer[] = [];
const onStart = jest.fn<(plan: CyclePlanInput) => void>();
const onStartMove = jest.fn(async (_plan: CyclePlanInput) => true);

async function render(mode: 'study' | 'move' = 'study'): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>
          <StartPanel
            mode={mode}
            permission="granted"
            requestPermission={async () => 'granted'}
            onStart={onStart}
            onStartMove={onStartMove}
            error={null}
          />
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
    .map((node) =>
      [node.props.children]
        .flat()
        .filter((c: unknown) => typeof c === 'string' || typeof c === 'number')
        .join(''),
    )
    .join(' | ');
}

function control(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  return renderer.root.find(
    (node) => typeof node.type === 'string' && node.props.accessibilityLabel === label && typeof node.props.onClick === 'function',
  );
}

function has(renderer: ReactTestRenderer, label: string): boolean {
  return (
    renderer.root.findAll(
      (node) => typeof node.type === 'string' && node.props.accessibilityLabel === label && typeof node.props.onClick === 'function',
    ).length > 0
  );
}

async function press(renderer: ReactTestRenderer, label: string) {
  await act(async () => control(renderer, label).props.onClick({}));
}

/** The text input labelled `label`. */
async function type(renderer: ReactTestRenderer, label: string, text: string) {
  const input = renderer.root.find((node) => (node.type as unknown) === 'TextInput' && node.props.accessibilityLabel === label);
  await act(async () => input.props.onChangeText(text));
}

const checked = (renderer: ReactTestRenderer, label: string) => control(renderer, label).props.accessibilityState?.checked;

/** One-tap setup first (the empty database has none), then Start. */
async function start(renderer: ReactTestRenderer) {
  await press(renderer, 'Home, just my body, No equipment needed');
  await press(renderer, 'Start focus block');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRows.clear();
  mockLocal.clear();
  mockPlans = PLANS;
  mockRows.set(PLAN_SOURCES_SQL, [
    { plan_source_id: 'ps-2', source_id: 's-2', added_at: '2026-10-08T10:00:00.000Z', title: 'Lecture 5', kind: 'pdf', url: null, status: 'ready', owner_id: null, card_count: 12 },
    { plan_source_id: 'ps-1', source_id: 's-1', added_at: '2026-10-01T10:00:00.000Z', title: 'Lecture 4', kind: 'pdf', url: null, status: 'ready', owner_id: null, card_count: 28 },
  ]);
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) act(() => renderer.unmount());
});

describe('with no study plan on the phone', () => {
  it('is exactly the Phase 1 panel: a free-text subject, and the plan sent has no study fields', async () => {
    mockPlans = [];
    const renderer = await render();
    const text = textOf(renderer);
    expect(text).toContain('What are you studying?');
    expect(text).not.toContain('Just a timer');
    await type(renderer, 'What are you studying?', 'Cell biology');
    await start(renderer);
    const [sent] = onStart.mock.calls[0];
    expect(sent.focusSubject).toBe('Cell biology');
    expect(sent).not.toHaveProperty('studyPlanId');
    expect(sent).not.toHaveProperty('studyFilter');
    expect(local.writeLocalState).not.toHaveBeenCalled();
  });
});

describe('the plan picker', () => {
  it('offers each plan with what it has, and just a timer (the default the first time)', async () => {
    const renderer = await render();
    const text = textOf(renderer);
    expect(text).toContain('What are you studying?');
    expect(checked(renderer, 'Just a timer, No cards')).toBe(true);
    expect(checked(renderer, 'Biology 101, 12 due · 5 new')).toBe(false);
    expect(has(renderer, 'Organic chemistry, 10 new')).toBe(true);
    expect(has(renderer, 'History, No cards yet')).toBe(true);
    // Just a timer keeps the free-text subject.
    expect(text).toContain('Subject');
    await start(renderer);
    expect(onStart.mock.calls[0][0]).not.toHaveProperty('studyPlanId');
    // The choice is remembered: just a timer.
    expect(local.writeLocalState).toHaveBeenCalledWith(STUDY_DEFAULTS_KEY, { planId: null, filter: 'all' });
  });

  it('a cumulative plan: everything so far or the newest source; Start quizzes from it', async () => {
    const renderer = await render();
    await press(renderer, 'Biology 101, 12 due · 5 new');
    expect(checked(renderer, 'Biology 101, 12 due · 5 new')).toBe(true);
    expect(checked(renderer, 'Just a timer, No cards')).toBe(false);
    // The subject is the plan's title now.
    expect(textOf(renderer)).not.toContain('Subject');
    expect(textOf(renderer)).toContain('All 2 sources, mixed together.');
    expect(checked(renderer, 'Everything so far')).toBe(true);
    await press(renderer, 'Newest source only');
    expect(textOf(renderer)).toContain('Only Lecture 5.');
    await start(renderer);
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ focusSubject: 'Biology 101', studyPlanId: BIO, studyFilter: 'newest', location: 'home' }),
    );
    expect(local.writeLocalState).toHaveBeenCalledWith(STUDY_DEFAULTS_KEY, { planId: BIO, filter: 'newest' });
  });

  it('a single-source plan has no filter', async () => {
    const renderer = await render();
    await press(renderer, 'Organic chemistry, 10 new');
    expect(has(renderer, 'Newest source only')).toBe(false);
    await start(renderer);
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ studyPlanId: CHEM, studyFilter: 'all', focusSubject: 'Organic chemistry' }));
  });

  it('a plan without cards says the block stays a plain timer', async () => {
    const renderer = await render();
    await press(renderer, 'History, No cards yet');
    expect(textOf(renderer)).toContain('This plan has no cards yet.');
  });

  it('starts from the last choice on this phone, so one tap on Start is enough', async () => {
    mockLocal.set(STUDY_DEFAULTS_KEY, { planId: BIO, filter: 'newest' });
    const renderer = await render();
    expect(checked(renderer, 'Biology 101, 12 due · 5 new')).toBe(true);
    expect(checked(renderer, 'Newest source only')).toBe(true);
    await start(renderer);
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ studyPlanId: BIO, studyFilter: 'newest' }));
  });

  it('a remembered plan that left the phone falls back to just a timer', async () => {
    mockLocal.set(STUDY_DEFAULTS_KEY, { planId: '90000000-0000-4000-8000-00000000dead', filter: 'all' });
    const renderer = await render();
    expect(checked(renderer, 'Just a timer, No cards')).toBe(true);
    await start(renderer);
    expect(onStart.mock.calls[0][0]).not.toHaveProperty('studyPlanId');
  });

  it('going back to just a timer drops the plan', async () => {
    mockLocal.set(STUDY_DEFAULTS_KEY, { planId: BIO, filter: 'all' });
    const renderer = await render();
    await press(renderer, 'Just a timer, No cards');
    await type(renderer, 'Subject', 'Reading');
    await start(renderer);
    const [sent] = onStart.mock.calls[0];
    expect(sent).not.toHaveProperty('studyPlanId');
    expect(sent.focusSubject).toBe('Reading');
  });

  it('a remembered choice that cannot be saved still starts', async () => {
    local.writeLocalState.mockRejectedValueOnce(new Error('disk full'));
    const renderer = await render();
    await press(renderer, 'Biology 101, 12 due · 5 new');
    await start(renderer);
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ studyPlanId: BIO }));
  });

  it('"Just train" has no picker', async () => {
    const renderer = await render('move');
    expect(textOf(renderer)).not.toContain('What are you studying?');
    expect(has(renderer, 'Just a timer, No cards')).toBe(false);
    await press(renderer, 'Home, just my body, No equipment needed');
    await press(renderer, 'Start workout');
    expect(onStartMove.mock.calls[0][0]).not.toHaveProperty('studyPlanId');
  });
});
