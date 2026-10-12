/**
 * The study screens (src/app/(app)/plans/**, Home's Study entry, Settings' study settings) on the
 * states a phone really meets: an empty database, material at each step of the pipeline, offline.
 * The live queries are answered from `mockRows` by their exact SQL (studyQueries.ts), so the real
 * hooks and progress rules run; the writes, the study function, the uploads and the router are mocks
 * whose calls the tests check. Nothing here touches the network or a native module.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as speechModule from 'expo-speech-recognition';
import type { ComponentType } from 'react';
import { Alert, Linking, Platform, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import {
  CARD_LINKS_SQL,
  CARD_SQL,
  DUE_COUNT_SQL,
  PLAN_CARDS_SQL,
  PLAN_JOBS_SQL,
  PLAN_LINKS_SQL,
  PLAN_SOURCE_FILES_SQL,
  PLAN_SOURCES_SQL,
  PLAN_SQL,
  PLANS_SQL,
  SOURCE_FILES_SQL,
  SOURCE_TEXT_SQL,
  TOPICS_SQL,
} from '@/features/study/studyQueries';
import { STUDY_DEFAULTS_KEY, STUDY_PREFS_KEY } from '@/features/study/studyPrefs';
import { textDraftKey } from '@/features/study/textDrafts';
import { ThemeProvider } from '@/theme';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const PLAN = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const NOW_ISO = '2026-10-09T10:00:00.000Z';

/** Rows for each live query, by its exact SQL text. */
const mockRows = new Map<string, unknown[]>();
/** local_state values by key (study prefs, study defaults, the cycle). */
const mockLocal = new Map<string, unknown>();
const mockStatus = { connected: true, connecting: false };

jest.mock('@powersync/react-native', () => ({
  useQuery: (sql: string) => ({ data: mockRows.get(sql) ?? [], isLoading: false }),
  useStatus: () => ({
    connected: mockStatus.connected,
    connecting: mockStatus.connecting,
    lastSyncedAt: undefined,
    dataFlowStatus: { uploading: false, downloading: false, uploadError: undefined, downloadError: undefined },
  }),
  usePowerSync: () => ({ getUploadQueueStats: async () => ({ count: 0 }) }),
}));
jest.mock('../../db/database', () => ({ db: {} }));
jest.mock('../../db/syncCheck', () => ({ getUploadQueueCount: async () => 0, waitForUploads: async () => 0 }));
jest.mock('../../features/cycle/localState', () => ({
  ...(jest.requireActual('../../features/cycle/localState') as object),
  useLocalState: (key: string) => ({ value: mockLocal.get(key) ?? null, isLoading: false }),
  readLocalState: jest.fn(async (key: string) => mockLocal.get(key) ?? null),
  readLocalStateByPrefix: jest.fn(async (prefix: string) =>
    [...mockLocal.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
  ),
  writeLocalState: jest.fn(async (key: string, value: unknown) => {
    mockLocal.set(key, value);
  }),
  deleteLocalState: jest.fn(async (key: string) => {
    mockLocal.delete(key);
  }),
}));
jest.mock('../../auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: '11111111-1111-4111-8111-111111111111', email: 'sam@example.com' }, signOut: jest.fn(), offlineSession: false }),
}));
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), dismissTo: jest.fn() };
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: mockRouter,
  useLocalSearchParams: () => mockParams,
  Stack: { Screen: () => null },
}));
jest.mock('../../features/timer/notifications', () => ({
  cancelAllAlerts: jest.fn(async () => undefined),
  getNotificationPermission: jest.fn(async () => 'undetermined'),
  requestNotificationPermission: jest.fn(async () => 'granted'),
  readAlertTestResult: async () => ({ status: 'none' }),
  scheduleAlertTest: async () => null,
}));
jest.mock('../../features/study/reminders', () => ({ rescheduleReviewReminder: jest.fn(async () => ({ status: 'off' })) }));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => undefined),
  selectionAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  performAndroidHapticsAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  AndroidHaptics: {},
}));
// The native pickers and file APIs upload.ts imports; the flow itself (addMaterial) is mocked below.
jest.mock('expo-file-system', () => ({ File: class {}, Directory: class {}, Paths: { cache: 'file:///cache/' } }));
jest.mock('expo-image-manipulator', () => ({ ImageManipulator: { manipulate: jest.fn() }, SaveFormat: { JPEG: 'jpeg' } }));
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  getPendingResultAsync: jest.fn(),
}));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
const mockSignedUrl = jest.fn(async (_path: string, _seconds: number) => ({ data: { signedUrl: 'https://example.test/signed.jpg' }, error: null }));
const mockSupabase = { storage: { from: () => ({ createSignedUrl: mockSignedUrl }) } };
jest.mock('../../lib/supabase', () => ({ supabase: mockSupabase }));
let mockIds = 0;
jest.mock('../../lib/ids', () => ({ newId: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String((mockIds += 1)).padStart(12, '0')}` }));
jest.mock('../../features/study/studyRepo', () => ({
  ...(jest.requireActual('../../features/study/studyRepo') as object),
  createPlan: jest.fn(async () => undefined),
  updatePlan: jest.fn(async () => true),
  deletePlan: jest.fn(async () => true),
  saveTranscript: jest.fn(async () => undefined),
  markTranscriptsConfirmed: jest.fn(async () => undefined),
  setCardSuspended: jest.fn(async () => undefined),
  createCard: jest.fn(async () => true),
  updateCard: jest.fn(async () => undefined),
  deleteCard: jest.fn(async () => undefined),
  createCardLink: jest.fn(async () => true),
  deleteCardLink: jest.fn(async () => undefined),
}));
jest.mock('../../features/study/studyApi', () => ({
  ...(jest.requireActual('../../features/study/studyApi') as object),
  retryJob: jest.fn(async () => ({ ok: true, job_id: 'j', status: 'queued' })),
  cancelJob: jest.fn(async () => ({ ok: true, job_id: 'j', status: 'cancelled' })),
  confirmTranscripts: jest.fn(async () => ({ ok: true, source_id: 's', chunks: 3, job_ids: [] })),
  approveOutline: jest.fn(async () => ({ ok: true, plan_id: 'p', source_ids: [], kept: 1, cut: 0, job_ids: [], already_approved: false })),
}));
jest.mock('../../features/study/upload', () => ({
  ...(jest.requireActual('../../features/study/upload') as object),
  addMaterial: jest.fn(async () => ({ ok: true, source_id: 's', status: 'processing', job_ids: [], already_submitted: false, sourceId: 's' })),
  pickDocuments: jest.fn(async () => []),
  pickPhotos: jest.fn(async () => []),
  takePhoto: jest.fn(async () => null),
  recoverPendingPhotos: jest.fn(async () => []),
  canTakePhoto: jest.fn(() => true),
  uploadContextFor: jest.fn(() => ({ client: {}, supabaseUrl: 'https://ref.supabase.co', publishableKey: 'pk' })),
}));

type AnyMock = jest.Mock<(...args: any[]) => any>;
const repo = jest.requireMock('../../features/study/studyRepo') as Record<string, AnyMock>;
const api = jest.requireMock('../../features/study/studyApi') as Record<string, AnyMock> & {
  StudyApiError: new (kind: string, details?: object) => Error;
};
const upload = jest.requireMock('../../features/study/upload') as Record<string, AnyMock>;
const local = jest.requireMock('../../features/cycle/localState') as Record<string, AnyMock>;

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 24, left: 0, right: 0, bottom: 16 } };

function screen(path: string): ComponentType {
  return (jest.requireActual(path) as { default: ComponentType }).default;
}

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

/** Renders the same screen again, as a sync that changed the rows it reads would. */
async function rerender(renderer: ReactTestRenderer, Screen: ComponentType): Promise<void> {
  await act(async () => {
    renderer.update(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>
          <Screen />
        </ThemeProvider>
      </SafeAreaProvider>,
    );
  });
}

function textOf(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => (node.type as unknown) === 'Text')
    .map((node) => [node.props.children].flat().filter((c: unknown) => typeof c === 'string' || typeof c === 'number').join(''))
    .join(' | ');
}

/** The pressable host element with this accessibility label. */
function control(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  return renderer.root.find(
    (node) => typeof node.type === 'string' && node.props.accessibilityLabel === label && typeof node.props.onClick === 'function',
  );
}

/** The full label of the control whose label starts with `prefix` (a row with a subtitle). */
function labelStarting(renderer: ReactTestRenderer, prefix: string): string {
  return renderer.root.find(
    (node) => typeof node.type === 'string' && String(node.props.accessibilityLabel).startsWith(prefix) && typeof node.props.onClick === 'function',
  ).props.accessibilityLabel as string;
}

function hasControl(renderer: ReactTestRenderer, label: string): boolean {
  return (
    renderer.root.findAll(
      (node) => typeof node.type === 'string' && node.props.accessibilityLabel === label && typeof node.props.onClick === 'function',
    ).length > 0
  );
}

function field(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  return renderer.root.find((node) => (node.type as unknown) === 'TextInput' && node.props.accessibilityLabel === label);
}

/** Taps a control and lets the promises it starts settle. */
async function tap(renderer: ReactTestRenderer, label: string): Promise<void> {
  await act(async () => {
    control(renderer, label).props.onClick({});
    for (let k = 0; k < 10; k += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  });
}

async function type(renderer: ReactTestRenderer, label: string, text: string): Promise<void> {
  await act(async () => {
    field(renderer, label).props.onChangeText(text);
  });
}

// ---- Rows ---------------------------------------------------------------------------------------

function planRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PLAN,
    owner_id: USER,
    group_id: null,
    title: 'Biology 101',
    scope: 'cumulative',
    goal: 'Pass the final',
    target_date: '2026-12-14',
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    source_count: 1,
    card_count: 0,
    due_count: 0,
    new_count: 0,
    ...overrides,
  };
}

function setPlan(overrides: Record<string, unknown> = {}) {
  const row = planRow(overrides);
  mockRows.set(PLAN_SQL, [row]);
  mockRows.set(PLANS_SQL, [row]);
}

function setSource(overrides: Record<string, unknown> = {}) {
  mockRows.set(PLAN_SOURCES_SQL, [
    {
      plan_source_id: 'ps1',
      source_id: SOURCE,
      added_at: NOW_ISO,
      title: 'Lecture notes',
      kind: 'notes',
      url: null,
      status: 'processing',
      owner_id: USER,
      card_count: 0,
      ...overrides,
    },
  ]);
}

const FILES = [
  { id: 'f1', source_id: SOURCE, storage_path: `${USER}/${SOURCE}/1.jpg`, page: 1, transcript: 'Mitochondria make ATP.', confirmed: 0 },
  { id: 'f2', source_id: SOURCE, storage_path: `${USER}/${SOURCE}/2.jpg`, page: 2, transcript: 'Ribosomes make protien.', confirmed: 0 },
];

function job(id: string, stage: string, status: string, error: string | null = null, created = NOW_ISO) {
  return { id, job: 'handwriting', stage, status, error, plan_id: PLAN, source_id: SOURCE, created_at: created, updated_at: created };
}

function topicRow(id: string, title: string, position: number, status: string, cardCount = 0) {
  return { id, plan_id: PLAN, title, position, status, card_count: cardCount };
}

function cardRow(id: string, question: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    topic_id: 't1',
    plan_id: PLAN,
    source_id: SOURCE,
    page: 12,
    question,
    answer: `Answer to ${question}`,
    card_type: 'basic',
    source_title: 'Lecture 3',
    state: null,
    due: null,
    suspended: null,
    reps: null,
    ...overrides,
  };
}

// Load every screen module once, before any test's 5 s clock starts. The first require of the app's
// screens transforms a large module graph; on a CI runner that took over 5 s, which timed out the
// first test, and its render then finished during later tests and broke all of them.
const SCREENS = [
  '../../app/(app)/index',
  '../../app/(app)/settings',
  '../../app/(app)/plans/index',
  '../../app/(app)/plans/new',
  '../../app/(app)/plans/[id]/index',
  '../../app/(app)/plans/[id]/edit',
  '../../app/(app)/plans/[id]/add',
  '../../app/(app)/plans/[id]/speak',
  '../../app/(app)/plans/[id]/notes/[sourceId]',
  '../../app/(app)/plans/[id]/check/[sourceId]',
  '../../app/(app)/plans/[id]/outline',
  '../../app/(app)/plans/[id]/cards/index',
  '../../app/(app)/plans/[id]/cards/[cardId]',
  '../../app/(app)/plans/[id]/map',
];

beforeAll(() => {
  for (const path of SCREENS) screen(path);
}, 60_000);

beforeEach(() => {
  mockRows.clear();
  mockLocal.clear();
  mockParams = {};
  mockStatus.connected = true;
  mockStatus.connecting = false;
  mockIds = 0;
  jest.clearAllMocks();
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) act(() => renderer.unmount());
});

// ---- Home and Settings --------------------------------------------------------------------------

describe('Home', () => {
  it('has a Study plans entry that shows the cards due', async () => {
    setPlan({ card_count: 10 });
    mockRows.set(DUE_COUNT_SQL, [{ n: 7 }]);
    const renderer = await render(screen('../../app/(app)/index'));
    expect(textOf(renderer)).toContain('7 cards due today');
    await tap(renderer, 'Study plans, 7 cards due today');
    expect(mockRouter.push).toHaveBeenLastCalledWith('/plans');
  });

  it('invites a first plan when there is none', async () => {
    const text = textOf(await render(screen('../../app/(app)/index')));
    expect(text).toContain('Study plans');
    expect(text).toContain('Turn your course material into cards');
  });
});

describe('Settings: signing out', () => {
  it('warns that unsent notes are only on this phone', async () => {
    mockLocal.set(textDraftKey(PLAN), { v: 1, planId: PLAN, sourceId: DRAFT_SOURCE, title: '', text: 'Cells divide.', updatedAt: 1 });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const renderer = await render(screen('../../app/(app)/settings'));
    await tap(renderer, 'Sign out');
    expect(alert).toHaveBeenCalledWith(
      'Sign out?',
      'Notes you haven’t added to their plan yet are only on this phone and will be lost. Add them first to keep them.',
      expect.arrayContaining([expect.objectContaining({ text: 'Sign out and lose notes', style: 'destructive' })]),
    );
    alert.mockRestore();
  });
});

describe('Settings: studying', () => {
  it('switches the answer buttons and typed answers, saved on this phone', async () => {
    const renderer = await render(screen('../../app/(app)/settings'));
    expect(textOf(renderer)).toContain('Missed it · Got it');
    await tap(renderer, 'Four buttons: Again, Hard, Good, Easy');
    expect(mockLocal.get(STUDY_PREFS_KEY)).toMatchObject({ answerButtons: 4, typedAnswers: false });
    await tap(renderer, labelStarting(renderer, 'Type short answers, '));
    expect(mockLocal.get(STUDY_PREFS_KEY)).toMatchObject({ answerButtons: 4, typedAnswers: true });
  });

  it('turns the reminder on (asking for notifications in context) and moves its time in quarter hours', async () => {
    const notifications = jest.requireMock('../../features/timer/notifications') as Record<string, AnyMock>;
    const renderer = await render(screen('../../app/(app)/settings'));
    expect(control(renderer, 'Increase Reminder time').props.accessibilityState).toEqual({ disabled: true });
    await tap(renderer, 'Remind me when cards are due');
    expect(mockLocal.get(STUDY_PREFS_KEY)).toMatchObject({ reminder: { enabled: true, hour: 18, minute: 0 } });
    expect(notifications.requestNotificationPermission).toHaveBeenCalledTimes(1);
    // The stubbed local state does not re-render on a write: open the screen again to see it.
    const again = await render(screen('../../app/(app)/settings'));
    await tap(again, 'Increase Reminder time');
    expect(mockLocal.get(STUDY_PREFS_KEY)).toMatchObject({ reminder: { enabled: true, hour: 18, minute: 15 } });
  });
});

// ---- Plans list and new plan --------------------------------------------------------------------

describe('Plans list', () => {
  it('explains plans when there are none, and offers a new one', async () => {
    const renderer = await render(screen('../../app/(app)/plans/index'));
    expect(textOf(renderer)).toContain('No plans yet');
    await tap(renderer, 'New plan');
    expect(mockRouter.push).toHaveBeenLastCalledWith('/plans/new');
  });

  it('lists plans with what is due', async () => {
    setPlan({ card_count: 40, due_count: 12, new_count: 30, source_count: 2 });
    const renderer = await render(screen('../../app/(app)/plans/index'));
    const text = textOf(renderer);
    expect(text).toContain('Biology 101');
    expect(text).toContain('12 due · 30 new · 2 sources');
    expect(text).toContain('12 cards are due across your plans.');
  });
});

describe('New plan', () => {
  it('needs a name, then saves on the phone and opens the plan', async () => {
    const renderer = await render(screen('../../app/(app)/plans/new'));
    await tap(renderer, 'Create plan');
    expect(repo.createPlan).not.toHaveBeenCalled();
    expect(textOf(renderer)).toContain('Give the plan a name');
    await type(renderer, 'Name', '  Biology 101 ');
    await tap(renderer, 'One source: A book, a handout or one set of slides.');
    await tap(renderer, 'Create plan');
    expect(repo.createPlan).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: USER, title: 'Biology 101', scope: 'single', goal: '', targetDate: null }),
    );
    const id = (repo.createPlan.mock.calls[0][0] as { id: string }).id;
    expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/plans/[id]', params: { id } });
  });
});

// ---- Plan detail --------------------------------------------------------------------------------

describe('Plan detail', () => {
  beforeEach(() => {
    mockParams = { id: PLAN };
  });

  it('with nothing added yet, the next step is adding material', async () => {
    setPlan({ source_count: 0 });
    const renderer = await render(screen('../../app/(app)/plans/[id]/index'));
    expect(textOf(renderer)).toContain('Nothing here yet');
    await tap(renderer, 'Add material');
    expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: '/plans/[id]/add', params: { id: PLAN } });
  });

  it('notes whose photos are all read: check the transcription', async () => {
    setPlan();
    setSource();
    mockRows.set(PLAN_SOURCE_FILES_SQL, FILES);
    mockRows.set(PLAN_JOBS_SQL, [job('j1', 'transcribe', 'succeeded'), job('j2', 'transcribe', 'succeeded')]);
    const renderer = await render(screen('../../app/(app)/plans/[id]/index'));
    const text = textOf(renderer);
    expect(text).toContain('Lecture notes');
    expect(text).toContain('2 pages to check');
    await tap(renderer, 'Check the transcription');
    expect(mockRouter.push).toHaveBeenLastCalledWith({
      pathname: '/plans/[id]/check/[sourceId]',
      params: { id: PLAN, sourceId: SOURCE },
    });
  });

  it('a failed step shows its error and Try again sends it back to the queue', async () => {
    setPlan();
    setSource({ kind: 'pdf', title: 'Lecture 3' });
    mockRows.set(PLAN_JOBS_SQL, [job('j9', 'extract', 'failed', 'The PDF could not be read.')]);
    const renderer = await render(screen('../../app/(app)/plans/[id]/index'));
    expect(textOf(renderer)).toContain('The PDF could not be read.');
    await tap(renderer, 'Try again');
    expect(api.retryJob).toHaveBeenCalledWith(mockSupabase, 'j9');
    expect(textOf(renderer)).toContain('Trying again');
  });

  it('a step that fails again after Try again shows the new failure, with Try again (the same job is reused)', async () => {
    setPlan();
    setSource({ kind: 'pdf', title: 'Lecture 3' });
    const failedAt = (at: string, error = 'Tracy declined this request.') => ({ ...job('j9', 'extract', 'failed', error), updated_at: at });
    mockRows.set(PLAN_JOBS_SQL, [failedAt('2026-10-09T12:00:00.000Z')]);
    const Plan = screen('../../app/(app)/plans/[id]/index');
    const renderer = await render(Plan);
    await tap(renderer, 'Try again');
    expect(textOf(renderer)).toContain('Trying again');
    expect(hasControl(renderer, 'Try again')).toBe(false);

    // The sync shows it queued, then failed once more.
    mockRows.set(PLAN_JOBS_SQL, [{ ...job('j9', 'extract', 'queued'), updated_at: '2026-10-09T12:00:01.000Z' }]);
    await rerender(renderer, Plan);
    expect(textOf(renderer)).not.toContain('Trying again');
    mockRows.set(PLAN_JOBS_SQL, [failedAt('2026-10-09T12:00:05.000Z')]);
    await rerender(renderer, Plan);
    expect(textOf(renderer)).toContain('Tracy declined this request.');
    expect(textOf(renderer)).not.toContain('Trying again');
    expect(textOf(renderer)).not.toContain('Getting your material ready');
    expect(hasControl(renderer, 'Try again')).toBe(true);

    // Also when the sync never showed it queued: a newer failure of the same job is a new failure.
    await tap(renderer, 'Try again');
    expect(textOf(renderer)).toContain('Trying again');
    mockRows.set(PLAN_JOBS_SQL, [failedAt('2026-10-09T12:01:00.000Z', 'The PDF could not be read.')]);
    await rerender(renderer, Plan);
    expect(textOf(renderer)).toContain('The PDF could not be read.');
    expect(hasControl(renderer, 'Try again')).toBe(true);
    expect(api.retryJob).toHaveBeenCalledTimes(2);
  });

  it('a failed retry says why (offline)', async () => {
    setPlan();
    setSource({ kind: 'pdf' });
    mockRows.set(PLAN_JOBS_SQL, [job('j9', 'extract', 'failed', 'Timed out.')]);
    api.retryJob.mockImplementationOnce(async () => {
      throw new api.StudyApiError('offline');
    });
    const renderer = await render(screen('../../app/(app)/plans/[id]/index'));
    await tap(renderer, 'Try again');
    expect(textOf(renderer)).toContain('No internet connection.');
  });

  it('a page that could not be read can be skipped', async () => {
    setPlan();
    setSource();
    mockRows.set(PLAN_SOURCE_FILES_SQL, FILES);
    mockRows.set(PLAN_JOBS_SQL, [job('j1', 'transcribe', 'succeeded'), job('j2', 'transcribe', 'failed', 'This page is too blurry to read.')]);
    const renderer = await render(screen('../../app/(app)/plans/[id]/index'));
    expect(textOf(renderer)).toContain('This page is too blurry to read.');
    await tap(renderer, 'Skip this page');
    expect(api.cancelJob).toHaveBeenCalledWith(mockSupabase, 'j2');
    expect(textOf(renderer)).toContain('Page skipped');
  });

  it('studying stays one tap away while new material waits for a review', async () => {
    setPlan({ card_count: 20 });
    setSource();
    mockRows.set(PLAN_SOURCE_FILES_SQL, FILES);
    mockRows.set(PLAN_JOBS_SQL, [job('j1', 'transcribe', 'succeeded'), job('j2', 'transcribe', 'succeeded')]);
    mockRows.set(TOPICS_SQL, [topicRow('t1', 'Cells', 0, 'ready', 20)]);
    const renderer = await render(screen('../../app/(app)/plans/[id]/index'));
    // The primary action is the review; studying is the secondary one.
    expect(hasControl(renderer, 'Check the transcription')).toBe(true);
    await tap(renderer, 'Study now');
    expect(mockRouter.push).toHaveBeenLastCalledWith('/cycle');
  });

  it('with cards, Study now opens the cycle with this plan chosen', async () => {
    setPlan({ card_count: 20, due_count: 5, new_count: 15 });
    setSource({ kind: 'pdf', status: 'ready', card_count: 20 });
    mockRows.set(PLAN_JOBS_SQL, [job('c1', 'cards', 'succeeded')]);
    mockRows.set(TOPICS_SQL, [topicRow('t1', 'Cells', 0, 'ready', 20)]);
    mockLocal.set(STUDY_DEFAULTS_KEY, { planId: null, filter: 'newest' });
    const renderer = await render(screen('../../app/(app)/plans/[id]/index'));
    const text = textOf(renderer);
    expect(text).toContain('Ready');
    expect(text).toContain('Cells');
    await tap(renderer, 'Study now');
    expect(local.writeLocalState).toHaveBeenCalledWith(STUDY_DEFAULTS_KEY, { planId: PLAN, filter: 'newest' });
    expect(mockRouter.push).toHaveBeenLastCalledWith('/cycle');
  });

  it("a group mate's plan hides the owner's actions", async () => {
    setPlan({ owner_id: OTHER, source_count: 0 });
    const renderer = await render(screen('../../app/(app)/plans/[id]/index'));
    expect(hasControl(renderer, 'Add material')).toBe(false);
    expect(hasControl(renderer, 'Plan settings, Name, kind, goal, date, delete')).toBe(false);
  });
});

describe('Plan settings', () => {
  beforeEach(() => {
    mockParams = { id: PLAN };
    setPlan();
  });

  it('starts from the saved plan and saves a change', async () => {
    const renderer = await render(screen('../../app/(app)/plans/[id]/edit'));
    expect(field(renderer, 'Name').props.value).toBe('Biology 101');
    await type(renderer, 'Name', 'Biology 102');
    await tap(renderer, 'No date');
    await tap(renderer, 'Save changes');
    expect(repo.updatePlan).toHaveBeenCalledWith(PLAN, { title: 'Biology 102', scope: 'cumulative', goal: 'Pass the final', targetDate: null });
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('deletes the plan after asking', async () => {
    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation((_title: string, _message?: string, buttons?: AlertButton[]) => buttons?.[1]?.onPress?.());
    mockLocal.set(textDraftKey(PLAN), { v: 1, planId: PLAN, sourceId: SOURCE, title: '', text: 'Unsent notes for it.', updatedAt: 1 });
    const renderer = await render(screen('../../app/(app)/plans/[id]/edit'));
    await tap(renderer, 'Delete plan');
    expect(alert).toHaveBeenCalledWith('Delete this plan?', expect.stringContaining('Biology 101'), expect.any(Array));
    expect(repo.deletePlan).toHaveBeenCalledWith(PLAN, USER);
    // Its unsent notes go with it (sign-out would otherwise warn about notes for a plan that is gone).
    expect(mockLocal.has(textDraftKey(PLAN))).toBe(false);
    expect(mockRouter.dismissTo).toHaveBeenCalledWith('/plans');
    alert.mockRestore();
  });

  it("is read-only for a group mate's plan", async () => {
    setPlan({ owner_id: OTHER });
    const renderer = await render(screen('../../app/(app)/plans/[id]/edit'));
    expect(textOf(renderer)).toContain('Only the owner can change this plan');
  });
});

// ---- Add material -------------------------------------------------------------------------------

describe('Add material', () => {
  beforeEach(() => {
    mockParams = { id: PLAN };
    setPlan({ source_count: 0 });
  });

  it('says up front that it needs the internet when offline', async () => {
    mockStatus.connected = false;
    const renderer = await render(screen('../../app/(app)/plans/[id]/add'));
    expect(textOf(renderer)).toContain('Adding material needs the internet');
  });

  it('asks for a file before adding', async () => {
    const renderer = await render(screen('../../app/(app)/plans/[id]/add'));
    await tap(renderer, 'Add to plan');
    expect(upload.addMaterial).not.toHaveBeenCalled();
    expect(textOf(renderer)).toContain('Choose a PDF or Word file first.');
  });

  it('adds a picked PDF and goes back to the plan', async () => {
    upload.pickDocuments.mockImplementationOnce(async () => [
      { uri: 'content://doc/1', name: 'Lecture 3.pdf', size: 2_000_000, mimeType: 'application/pdf' },
    ]);
    const renderer = await render(screen('../../app/(app)/plans/[id]/add'));
    await tap(renderer, 'Choose a file');
    expect(textOf(renderer)).toContain('Lecture 3.pdf');
    await tap(renderer, 'Add to plan');
    expect(upload.addMaterial).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'pdf', document: expect.objectContaining({ name: 'Lecture 3.pdf' }) }),
      expect.objectContaining({ userId: USER, planId: PLAN }),
    );
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('refuses a file that is too large before uploading anything', async () => {
    upload.pickDocuments.mockImplementationOnce(async () => [
      { uri: 'content://doc/2', name: 'Huge.pdf', size: 40 * 1024 * 1024, mimeType: 'application/pdf' },
    ]);
    const renderer = await render(screen('../../app/(app)/plans/[id]/add'));
    await tap(renderer, 'Choose a file');
    expect(textOf(renderer)).toContain('Huge.pdf is larger than 25 MB.');
  });

  it('photos: hides Take a photo where the camera cannot work, and keeps the source id for a retry', async () => {
    upload.canTakePhoto.mockReturnValue(false);
    upload.pickPhotos.mockImplementationOnce(async () => [
      { uri: 'file:///p1.jpg', width: 3000, height: 4000, fileSize: 1, mimeType: 'image/jpeg', fileName: 'p1.jpg' },
      { uri: 'file:///p2.jpg', width: 3000, height: 4000, fileSize: 1, mimeType: 'image/jpeg', fileName: 'p2.jpg' },
    ]);
    upload.addMaterial.mockImplementationOnce(async () => {
      throw new api.StudyApiError('cap_reached', { cap: { stage: 'transcribe', used: 20, limit: 20, resetsAt: Date.UTC(2026, 10, 1) } });
    });
    const renderer = await render(screen('../../app/(app)/plans/[id]/add'));
    await tap(renderer, 'Photos of handwritten notes');
    expect(hasControl(renderer, 'Take a photo')).toBe(false);
    await tap(renderer, 'Choose photos from the gallery');
    expect(textOf(renderer)).toContain('Page 2');
    // Reorder: page 2 becomes page 1.
    await tap(renderer, 'Move Page 2 up');
    await tap(renderer, 'Add to plan');
    expect(textOf(renderer)).toContain('You’ve used all 20 handwritten and scanned pages for this month.');
    const first = upload.addMaterial.mock.calls[0] as unknown as [unknown, { photos: { uri: string }[] }, { sourceId: string }];
    expect(first[1].photos.map((photo) => photo.uri)).toEqual(['file:///p2.jpg', 'file:///p1.jpg']);
    await tap(renderer, 'Add to plan');
    const second = upload.addMaterial.mock.calls[1] as unknown as [unknown, unknown, { sourceId: string }];
    expect(second[2].sourceId).toBe(first[2].sourceId);
    upload.canTakePhoto.mockReturnValue(true);
  });

  it('a link needs an https address', async () => {
    const renderer = await render(screen('../../app/(app)/plans/[id]/add'));
    await tap(renderer, 'A web page');
    await type(renderer, 'Web address', 'example.com/notes');
    await tap(renderer, 'Add to plan');
    expect(upload.addMaterial).not.toHaveBeenCalled();
    expect(textOf(renderer)).toContain('starts with https://');
    await type(renderer, 'Web address', 'https://example.com/notes');
    await tap(renderer, 'Add to plan');
    expect(upload.addMaterial).toHaveBeenCalledWith(
      expect.anything(),
      { kind: 'link', url: 'https://example.com/notes', title: '' },
      expect.objectContaining({ planId: PLAN }),
    );
  });
});

// ---- Spoken or typed notes ----------------------------------------------------------------------

type SpeechStandIn = {
  ExpoSpeechRecognitionModule: Record<string, AnyMock>;
  __emit: (name: string, payload?: unknown) => void;
  __reset: () => void;
};
// The stand-in from __mocks__/expo-speech-recognition.ts, as the screen imports it.
const speech = speechModule as unknown as SpeechStandIn;
const recognizer = speech.ExpoSpeechRecognitionModule;
const DRAFT_SOURCE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Plays an Android phone of this API level (the screen reads Platform when it renders). */
function androidPhone(api: number): void {
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(Platform, 'Version', 'get').mockReturnValue(api);
}

async function hear(name: string, payload: unknown = null): Promise<void> {
  await act(async () => {
    speech.__emit(name, payload);
  });
}

const said = (transcript: string, isFinal: boolean) => ({ isFinal, results: [{ transcript, confidence: 0.9, segments: [] }] });

describe('Speak or type notes', () => {
  beforeEach(() => {
    mockParams = { id: PLAN };
    setPlan({ source_count: 0 });
    speech.__reset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Add material opens it', async () => {
    const renderer = await render(screen('../../app/(app)/plans/[id]/add'));
    await tap(renderer, labelStarting(renderer, 'Speak or type notes'));
    expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: '/plans/[id]/speak', params: { id: PLAN } });
  });

  it('on the phone, offline: says so, the live words come in greyed, and Add to plan sends the notes', async () => {
    androidPhone(34);
    const renderer = await render(screen('../../app/(app)/plans/[id]/speak'));
    expect(textOf(renderer)).toContain('Works on this phone, offline');
    expect(textOf(renderer)).toContain('Language: English (US) (works offline)');
    expect(textOf(renderer)).toContain('DualRep listens only while the mic is on, and keeps no recording.');
    await tap(renderer, 'Start speaking');
    expect(recognizer.start).toHaveBeenCalledWith(expect.objectContaining({ lang: 'en-US', continuous: true, requiresOnDeviceRecognition: true }));
    await hear('start');
    expect(textOf(renderer)).toContain('Listening for English (US). Tap Pause when you’re done.');
    expect(field(renderer, 'Your notes').props.readOnly).toBe(true);
    await hear('result', said('cells divide', false));
    expect(textOf(renderer)).toContain('…cells divide');
    await hear('result', said('cells divide by mitosis', true));
    expect(field(renderer, 'Your notes').props.value).toBe('cells divide by mitosis');
    await tap(renderer, 'Pause speaking');
    expect(recognizer.stop).toHaveBeenCalledTimes(1);
    await hear('end');
    expect(field(renderer, 'Your notes').props.readOnly).toBe(false);
    expect(textOf(renderer)).toContain('Paused. Tap the mic to carry on.');
    await type(renderer, 'Name (optional)', 'Week 4');
    await tap(renderer, 'Add to plan');
    expect(upload.addMaterial).toHaveBeenCalledWith(
      expect.anything(),
      { kind: 'text', text: 'cells divide by mitosis', title: 'Week 4' },
      expect.objectContaining({ userId: USER, planId: PLAN, sourceId: expect.stringMatching(/^aaaaaaaa-/) }),
    );
    expect(mockLocal.has(textDraftKey(PLAN))).toBe(false);
    expect(mockRouter.dismissTo).toHaveBeenCalledWith({ pathname: '/plans/[id]', params: { id: PLAN } });
  });

  it('Add to plan while listening waits for the last words', async () => {
    androidPhone(34);
    const renderer = await render(screen('../../app/(app)/plans/[id]/speak'));
    await tap(renderer, 'Start speaking');
    await hear('result', said('the krebs', false));
    await act(async () => {
      control(renderer, 'Add to plan').props.onClick({});
    });
    expect(recognizer.stop).toHaveBeenCalledTimes(1);
    expect(upload.addMaterial).not.toHaveBeenCalled();
    await hear('result', said('the krebs cycle', true));
    await hear('end');
    await act(async () => {
      for (let k = 0; k < 10; k += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    });
    expect(upload.addMaterial).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ text: 'the krebs cycle' }), expect.anything());
  });

  it('the online service: says what goes to Google, and offers the offline download', async () => {
    androidPhone(34);
    mockLocal.set(STUDY_PREFS_KEY, { dictationLang: 'en-GB' });
    const renderer = await render(screen('../../app/(app)/plans/[id]/speak'));
    const text = textOf(renderer);
    expect(text).toContain('Uses Google’s online speech service: what you say is sent to Google to be turned into text');
    expect(text).toContain('Language: English (UK) |');
    recognizer.getSupportedLocales.mockResolvedValue({ locales: ['en-US', 'en-GB'], installedLocales: ['en-US', 'en-GB'] });
    await tap(renderer, 'Download English (UK) for offline use');
    expect(recognizer.androidTriggerOfflineModelDownload).toHaveBeenCalledWith({ locale: 'en-GB' });
    expect(textOf(renderer)).toContain('English (UK) is on this phone now.');
    expect(textOf(renderer)).toContain('Works on this phone, offline');
  });

  it('Android 12: plain sessions with no Android-13 settings', async () => {
    androidPhone(31);
    const renderer = await render(screen('../../app/(app)/plans/[id]/speak'));
    expect(textOf(renderer)).toContain('Uses Google’s online speech service');
    await tap(renderer, 'Start speaking');
    const options = recognizer.start.mock.calls[0][0] as Record<string, unknown>;
    expect(options).toMatchObject({ continuous: false, requiresOnDeviceRecognition: false });
    expect(options).not.toHaveProperty('androidIntentOptions');
  });

  it('the language can be changed (English first), and is kept for this phone', async () => {
    androidPhone(34);
    const renderer = await render(screen('../../app/(app)/plans/[id]/speak'));
    await tap(renderer, 'Change the language, now English (US)');
    await tap(renderer, 'English (India)');
    expect(mockLocal.get(STUDY_PREFS_KEY)).toMatchObject({ dictationLang: 'en-IN' });
  });

  it('no speech service: typing only, with the keyboard microphone; offline, the notes stay on the phone', async () => {
    recognizer.isRecognitionAvailable.mockReturnValue(false);
    mockStatus.connected = false;
    upload.addMaterial.mockImplementationOnce(async () => {
      throw new api.StudyApiError('offline');
    });
    const renderer = await render(screen('../../app/(app)/plans/[id]/speak'));
    const text = textOf(renderer);
    expect(text).toContain('No speech-to-text on this phone');
    expect(text).toContain('Your keyboard’s microphone works here too.');
    expect(text).toContain('Adding the notes to the plan needs the internet.');
    expect(hasControl(renderer, 'Start speaking')).toBe(false);
    await type(renderer, 'Your notes', 'Osmosis moves water across a membrane.');
    await tap(renderer, 'Add to plan');
    expect(textOf(renderer)).toContain('No internet connection.');
    expect(mockLocal.get(textDraftKey(PLAN))).toMatchObject({
      v: 1,
      planId: PLAN,
      text: 'Osmosis moves water across a membrane.',
      sourceId: (upload.addMaterial.mock.calls[0][2] as { sourceId: string }).sourceId,
    });
  });

  it('unsent notes come back with their source id; changed notes the server already has go under a new one', async () => {
    mockLocal.set(textDraftKey(PLAN), { v: 1, planId: PLAN, sourceId: DRAFT_SOURCE, title: 'Week 4', text: 'Cells divide.', updatedAt: 1 });
    upload.addMaterial.mockImplementationOnce(async () => {
      throw new api.StudyApiError('conflict', {
        status: 409,
        serverMessage: 'These notes were already added before your last changes. Add them again as new notes to keep the changes.',
      });
    });
    const renderer = await render(screen('../../app/(app)/plans/[id]/speak'));
    expect(field(renderer, 'Your notes').props.value).toBe('Cells divide.');
    expect(field(renderer, 'Name (optional)').props.value).toBe('Week 4');
    await tap(renderer, 'Add to plan');
    expect((upload.addMaterial.mock.calls[0][2] as { sourceId: string }).sourceId).toBe(DRAFT_SOURCE);
    expect(textOf(renderer)).toContain('Add them again as new notes to keep the changes.');
    await tap(renderer, 'Add to plan');
    const second = (upload.addMaterial.mock.calls[1][2] as { sourceId: string }).sourceId;
    expect(second).not.toBe(DRAFT_SOURCE);
    expect(mockRouter.dismissTo).toHaveBeenCalled();
  });

  it('the microphone refused for good: says how to allow it, and typing still works', async () => {
    androidPhone(34);
    recognizer.getPermissionsAsync.mockResolvedValue({ granted: false, status: 'denied', canAskAgain: false, expires: 'never' });
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    const renderer = await render(screen('../../app/(app)/plans/[id]/speak'));
    expect(textOf(renderer)).toContain('Microphone access is off');
    await tap(renderer, 'Start speaking');
    expect(recognizer.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(recognizer.start).not.toHaveBeenCalled();
    await tap(renderer, 'Open system settings');
    expect(openSettings).toHaveBeenCalled();
    expect(field(renderer, 'Your notes').props.readOnly).toBe(false);
  });

  it('notes over 20,000 characters are not sent; the screen says how to fix it', async () => {
    const renderer = await render(screen('../../app/(app)/plans/[id]/speak'));
    await type(renderer, 'Your notes', 'x'.repeat(20_001));
    expect(textOf(renderer)).toContain('20,001 of 20,000 characters. Shorten the notes, or add the rest as another set of notes.');
    await tap(renderer, 'Add to plan');
    expect(upload.addMaterial).not.toHaveBeenCalled();
    expect(textOf(renderer)).toContain('One set of notes can be up to 20,000 characters.');
  });

  it('dictation that reaches 20,000 characters leaves notes Add to plan takes; what didn’t fit starts the next set', async () => {
    androidPhone(34);
    const typed = 'x'.repeat(19_990);
    mockLocal.set(textDraftKey(PLAN), { v: 1, planId: PLAN, sourceId: DRAFT_SOURCE, title: 'Lecture 3', text: typed, updatedAt: 1 });
    const renderer = await render(screen('../../app/(app)/plans/[id]/speak'));
    await tap(renderer, 'Start speaking');
    await hear('result', said('and that is the end of the lecture on mitosis', true));
    expect(recognizer.stop).toHaveBeenCalledTimes(1);
    await hear('end');
    const text = textOf(renderer);
    expect(text).toContain('That’s the most one set of notes can hold (20,000 characters). Add it to the plan, then start another.');
    expect(text).toContain('Didn’t fit in these notes, so they’ll start your next set: “is the end of the lecture on mitosis”');
    expect(text).not.toContain('Shorten');
    expect(field(renderer, 'Your notes').props.value).toBe(`${typed}\n\nand that`);
    // Closing the app now would lose nothing: the pause saved both at once.
    expect(mockLocal.get(textDraftKey(PLAN))).toMatchObject({ text: `${typed}\n\nand that`, overflow: 'is the end of the lecture on mitosis' });
    await tap(renderer, 'Add to plan');
    expect(textOf(renderer)).not.toContain('Not added');
    expect(upload.addMaterial).toHaveBeenCalledWith(
      expect.anything(),
      { kind: 'text', text: `${typed}\n\nand that`, title: 'Lecture 3' },
      expect.objectContaining({ sourceId: DRAFT_SOURCE }),
    );
    // The plan shows the rest as Unsent notes: new notes, under a new source id.
    const next = mockLocal.get(textDraftKey(PLAN)) as Record<string, unknown>;
    expect(next).toMatchObject({ v: 1, planId: PLAN, title: '', text: 'is the end of the lecture on mitosis' });
    expect(next.sourceId).not.toBe(DRAFT_SOURCE);
    expect(next).not.toHaveProperty('overflow');
    expect(mockRouter.dismissTo).toHaveBeenCalledWith({ pathname: '/plans/[id]', params: { id: PLAN } });
  });

  it('typed notes over the limit: Start speaking says to shorten them, not to add them', async () => {
    androidPhone(34);
    const renderer = await render(screen('../../app/(app)/plans/[id]/speak'));
    await type(renderer, 'Your notes', 'x'.repeat(20_001));
    await tap(renderer, 'Start speaking');
    expect(recognizer.start).not.toHaveBeenCalled();
    const text = textOf(renderer);
    expect(text).toContain('These notes are over 20,000 characters, the most one set can hold. Shorten them, then add them to the plan.');
    expect(text).not.toContain('Add it to the plan');
  });

  it('the speech service without the microphone (code 9): says which app needs it, not DualRep', async () => {
    androidPhone(31);
    const renderer = await render(screen('../../app/(app)/plans/[id]/speak'));
    await tap(renderer, 'Start speaking');
    await hear('error', { error: 'service-not-allowed', message: 'Insufficient permissions', code: 9 });
    await hear('end');
    await act(async () => {
      for (let k = 0; k < 10; k += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    });
    const text = textOf(renderer);
    expect(text).toContain(
      'The phone’s speech service (Speech Services by Google) isn’t allowed to use the microphone, so it can’t hear you. Allow the microphone for Speech Services by Google in system settings',
    );
    expect(text).not.toContain('DualRep needs the microphone');
    expect(text).not.toContain('Microphone access is off');
    // The on-device recognizer may be another app than the default service: it isn't named then.
    androidPhone(34);
    const onPhone = await render(screen('../../app/(app)/plans/[id]/speak'));
    await tap(onPhone, 'Start speaking');
    await hear('error', { error: 'service-not-allowed', message: 'Insufficient permissions', code: 9 });
    await hear('end');
    expect(textOf(onPhone)).toContain('The phone’s speech service isn’t allowed to use the microphone, so it can’t hear you.');
  });

  it('language names on a phone without Intl.DisplayNames (Hermes): names, not codes', async () => {
    const intl = Intl as unknown as { DisplayNames?: unknown };
    const displayNames = intl.DisplayNames;
    delete intl.DisplayNames;
    try {
      androidPhone(34);
      recognizer.getSupportedLocales.mockResolvedValue({ locales: ['en-US', 'de-DE', 'fr-FR'], installedLocales: ['en-US'] });
      mockLocal.set(STUDY_PREFS_KEY, { dictationLang: 'de-DE' });
      const renderer = await render(screen('../../app/(app)/plans/[id]/speak'));
      expect(textOf(renderer)).toContain('Language: German (Germany)');
      await tap(renderer, 'Change the language, now German (Germany)');
      expect(hasControl(renderer, 'French (France)')).toBe(true);
      expect(textOf(renderer)).not.toContain('de-DE');
      expect(textOf(renderer)).not.toContain('fr-FR');
    } finally {
      intl.DisplayNames = displayNames;
    }
  });

  it('clearing asks first', async () => {
    let buttons: AlertButton[] = [];
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, given) => {
      buttons = given ?? [];
    });
    const renderer = await render(screen('../../app/(app)/plans/[id]/speak'));
    await type(renderer, 'Your notes', 'Something to forget.');
    await tap(renderer, 'Clear the notes');
    expect(field(renderer, 'Your notes').props.value).toBe('Something to forget.');
    await act(async () => buttons.find((button) => button.style === 'destructive')?.onPress?.());
    expect(field(renderer, 'Your notes').props.value).toBe('');
  });

  it('notes typed after clearing are new notes, under a new source id', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, given) => {
      given?.find((button) => button.style === 'destructive')?.onPress?.();
    });
    mockLocal.set(textDraftKey(PLAN), { v: 1, planId: PLAN, sourceId: DRAFT_SOURCE, title: '', text: 'Sent once, answer lost.', updatedAt: 1 });
    const renderer = await render(screen('../../app/(app)/plans/[id]/speak'));
    await tap(renderer, 'Clear the notes');
    await type(renderer, 'Your notes', 'Something else entirely.');
    await tap(renderer, 'Add to plan');
    const sent = upload.addMaterial.mock.calls[0];
    expect(sent[1]).toMatchObject({ text: 'Something else entirely.' });
    expect((sent[2] as { sourceId: string }).sourceId).not.toBe(DRAFT_SOURCE);
  });

  it('a second tap on Add to plan while the last words come in sends the notes once', async () => {
    androidPhone(34);
    const renderer = await render(screen('../../app/(app)/plans/[id]/speak'));
    await tap(renderer, 'Start speaking');
    await hear('result', said('the krebs', false));
    await act(async () => {
      control(renderer, 'Add to plan').props.onClick({});
      control(renderer, 'Add to plan').props.onClick({});
    });
    await hear('result', said('the krebs cycle', true));
    await hear('end');
    await act(async () => {
      for (let k = 0; k < 10; k += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    });
    expect(upload.addMaterial).toHaveBeenCalledTimes(1);
  });

  it('the plan shows unsent notes with a way back to them', async () => {
    mockStatus.connected = false;
    mockLocal.set(textDraftKey(PLAN), { v: 1, planId: PLAN, sourceId: DRAFT_SOURCE, title: '', text: 'Cells divide by mitosis.', updatedAt: 1 });
    const renderer = await render(screen('../../app/(app)/plans/[id]/index'));
    const text = textOf(renderer);
    expect(text).toContain('Unsent notes');
    expect(text).toContain('Saved on this phone. Add them to the plan when you’re back online.');
    expect(text).toContain('Cells divide by mitosis.');
    await tap(renderer, 'Open the notes');
    expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: '/plans/[id]/speak', params: { id: PLAN } });
  });

  it('added notes can be read again on their own page, offline', async () => {
    setPlan();
    setSource({ kind: 'text', title: 'Notes, 12 Oct', status: 'processing' });
    mockRows.set(PLAN_JOBS_SQL, [job('j1', 'extract', 'succeeded'), job('j2', 'outline', 'running')]);
    const plan = await render(screen('../../app/(app)/plans/[id]/index'));
    expect(textOf(plan)).toContain('Spoken or typed notes');
    expect(textOf(plan)).not.toContain('Check the transcription');
    await tap(plan, 'Read the notes: Notes, 12 Oct');
    expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: '/plans/[id]/notes/[sourceId]', params: { id: PLAN, sourceId: SOURCE } });

    mockParams = { id: PLAN, sourceId: SOURCE };
    mockStatus.connected = false;
    mockRows.set(SOURCE_TEXT_SQL, [
      { id: SOURCE, title: 'Notes, 12 Oct', kind: 'text', body: 'Cells divide by mitosis.\n\nOsmosis moves water.', status: 'processing', owner_id: USER, created_at: NOW_ISO },
    ]);
    const page = await render(screen('../../app/(app)/plans/[id]/notes/[sourceId]'));
    const text = textOf(page);
    expect(text).toContain('Notes, 12 Oct');
    expect(text).toContain('Cells divide by mitosis.\n\nOsmosis moves water.');
    expect(text).toContain('Making the outline');
  });

  it('a note page for notes not on the phone says so', async () => {
    mockParams = { id: PLAN, sourceId: SOURCE };
    const page = await render(screen('../../app/(app)/plans/[id]/notes/[sourceId]'));
    expect(textOf(page)).toContain('These notes aren’t on this phone');
  });
});

// ---- Transcription review -----------------------------------------------------------------------

describe('Transcription review', () => {
  beforeEach(() => {
    mockParams = { id: PLAN, sourceId: SOURCE };
    setPlan();
    setSource();
    mockRows.set(SOURCE_FILES_SQL, FILES);
    mockRows.set(PLAN_SOURCE_FILES_SQL, FILES);
    mockRows.set(PLAN_JOBS_SQL, [job('j1', 'transcribe', 'succeeded'), job('j2', 'transcribe', 'succeeded')]);
  });

  it('shows each page with its photo and editable text; Confirm sends the corrected text', async () => {
    const renderer = await render(screen('../../app/(app)/plans/[id]/check/[sourceId]'));
    expect(mockSignedUrl).toHaveBeenCalledWith(`${USER}/${SOURCE}/1.jpg`, 600);
    expect(renderer.root.findAll((node) => node.props.accessibilityLabel === 'Photo of page 2' && typeof node.type === 'string').length).toBe(1);
    await type(renderer, 'Text of page 2', 'Ribosomes make protein.');
    await act(async () => {
      field(renderer, 'Text of page 2').props.onBlur({});
    });
    expect(repo.saveTranscript).toHaveBeenCalledWith('f2', 'Ribosomes make protein.');
    await tap(renderer, 'Confirm');
    const final = [
      { id: 'f1', transcript: 'Mitochondria make ATP.' },
      { id: 'f2', transcript: 'Ribosomes make protein.' },
    ];
    expect(api.confirmTranscripts).toHaveBeenCalledWith(mockSupabase, { plan_id: PLAN, source_id: SOURCE, files: final });
    expect(repo.markTranscriptsConfirmed).toHaveBeenCalledWith(final);
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('offline: the text can still be checked, and the photo says it needs the internet', async () => {
    mockStatus.connected = false;
    mockSignedUrl.mockImplementationOnce(async () => {
      throw new Error('Network request failed');
    });
    const renderer = await render(screen('../../app/(app)/plans/[id]/check/[sourceId]'));
    const text = textOf(renderer);
    expect(text).toContain('Confirming the text needs the internet');
    expect(text).toContain('The photo shows when you’re online.');
  });
});

// ---- Outline review -----------------------------------------------------------------------------

describe('Outline review', () => {
  beforeEach(() => {
    mockParams = { id: PLAN };
    setPlan();
    mockRows.set(TOPICS_SQL, [
      topicRow('t0', 'Basics', 0, 'ready', 8),
      topicRow('a', 'Cells', 1, 'draft'),
      topicRow('b', 'Energy', 2, 'draft'),
      topicRow('c', 'Genes', 3, 'draft'),
    ]);
  });

  it('keeps, cuts, renames and reorders with buttons, then sends the whole decision', async () => {
    const renderer = await render(screen('../../app/(app)/plans/[id]/outline'));
    const text = textOf(renderer);
    expect(text).toContain('Already in this plan');
    expect(text).toContain('Basics');
    expect(text).toContain('3 topics kept');
    expect(control(renderer, 'Move Cells up').props.accessibilityState).toEqual({ disabled: true, busy: false });
    await tap(renderer, 'Move Genes up');
    await tap(renderer, 'Cut Cells');
    await type(renderer, 'Name of topic 2', 'Genetics');
    expect(textOf(renderer)).toContain('2 topics kept, 1 cut');
    await tap(renderer, 'Save and make cards');
    expect(api.approveOutline).toHaveBeenCalledWith(mockSupabase, {
      plan_id: PLAN,
      source_id: null,
      topics: [
        { id: 'a', keep: false },
        { id: 'c', title: 'Genetics', keep: true },
        { id: 'b', keep: true },
      ],
    });
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('screen-reader actions move and cut too', async () => {
    const renderer = await render(screen('../../app/(app)/plans/[id]/outline'));
    const row = () =>
      renderer.root.find((node) => typeof node.type === 'string' && String(node.props.accessibilityLabel).startsWith('Topic 3 of 3'));
    expect(row().props.accessibilityActions.map((action: { name: string }) => action.name)).toEqual(['moveUp', 'toggle']);
    await act(async () => row().props.onAccessibilityAction({ nativeEvent: { actionName: 'moveUp' } }));
    expect(textOf(renderer)).toMatch(/Topic 2 of 3.*Topic 3 of 3/);
    const moved = renderer.root.find((node) => typeof node.type === 'string' && String(node.props.accessibilityLabel).startsWith('Topic 2 of 3'));
    expect(moved.props.accessibilityLabel).toBe('Topic 2 of 3: Genes, kept');
  });

  it('asks before cutting every topic', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const renderer = await render(screen('../../app/(app)/plans/[id]/outline'));
    for (const name of ['Cells', 'Energy', 'Genes']) await tap(renderer, `Cut ${name}`);
    await tap(renderer, 'Save and make cards');
    expect(alert).toHaveBeenCalledWith('Cut every topic?', expect.any(String), expect.any(Array));
    expect(api.approveOutline).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0][2] as AlertButton[];
    await act(async () => {
      buttons[1].onPress?.();
      for (let k = 0; k < 5; k += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    });
    expect(api.approveOutline).toHaveBeenCalledTimes(1);
    alert.mockRestore();
  });

  it('says so when there is nothing to review', async () => {
    mockRows.set(TOPICS_SQL, [topicRow('t0', 'Basics', 0, 'ready', 8)]);
    const renderer = await render(screen('../../app/(app)/plans/[id]/outline'));
    expect(textOf(renderer)).toContain('No outline to review');
  });
});

// ---- Cards, card, map ---------------------------------------------------------------------------

describe('Cards and the concept map', () => {
  const CARDS = [
    cardRow('c1', 'What makes ATP?', { state: 2, due: '2026-01-01T00:00:00.000Z', suspended: 0 }),
    cardRow('c2', 'What are ribosomes for?', { topic_id: 't2' }),
    cardRow('c3', 'Why do cells divide?', { source_id: null, page: null, source_title: null }),
  ];

  beforeEach(() => {
    setPlan({ card_count: 3 });
    mockRows.set(TOPICS_SQL, [topicRow('t1', 'Cells', 0, 'ready', 2), topicRow('t2', 'Proteins', 1, 'ready', 1)]);
    mockRows.set(PLAN_CARDS_SQL, CARDS);
  });

  it('the browser lists cards with when they come back and their page, by topic', async () => {
    mockParams = { id: PLAN };
    const renderer = await render(screen('../../app/(app)/plans/[id]/cards/index'));
    let text = textOf(renderer);
    expect(text).toContain('3 cards');
    expect(text).toContain('Due now · Cells · p. 12, Lecture 3');
    expect(text).toContain('Made by hand');
    await tap(renderer, 'Proteins');
    text = textOf(renderer);
    expect(text).toContain('Proteins: 1 card');
    expect(text).not.toContain('What makes ATP?');
    await tap(renderer, 'Add a card');
    expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: '/plans/[id]/cards/[cardId]', params: { id: PLAN, cardId: 'new', topic: 't2' } });
  });

  it('a card shows its answer, its page and its links; it can be paused', async () => {
    mockParams = { id: PLAN, cardId: 'c1' };
    mockRows.set(CARD_SQL, [CARDS[0]]);
    mockRows.set(CARD_LINKS_SQL, [
      { id: 'l1', from_card_id: 'c2', to_card_id: 'c1', relation: 'prerequisite', note: null, created_by: USER, other_card_id: 'c2', other_question: 'What are ribosomes for?' },
    ]);
    const renderer = await render(screen('../../app/(app)/plans/[id]/cards/[cardId]'));
    const text = textOf(renderer);
    expect(text).toContain('Answer to What makes ATP?');
    expect(text).toContain('p. 12, Lecture 3');
    expect(text).toContain('Learn this first');
    await tap(renderer, 'Pause this card');
    expect(repo.setCardSuspended).toHaveBeenCalledWith(USER, 'c1', true);
    await tap(renderer, 'See it on the concept map');
    expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: '/plans/[id]/map', params: { id: PLAN, card: 'c1' } });
  });

  it('a new card needs a question and an answer, then is saved on the phone', async () => {
    mockParams = { id: PLAN, cardId: 'new', topic: 't1' };
    const renderer = await render(screen('../../app/(app)/plans/[id]/cards/[cardId]'));
    await tap(renderer, 'Save card');
    expect(repo.createCard).not.toHaveBeenCalled();
    await type(renderer, 'Question', 'What is osmosis?');
    await type(renderer, 'Answer', 'Water moving across a membrane');
    await tap(renderer, 'Save card');
    expect(repo.createCard).toHaveBeenCalledWith(expect.objectContaining({ topicId: 't1', question: 'What is osmosis?' }));
    expect(mockRouter.replace).toHaveBeenCalled();
  });

  it('the map puts the card in the middle, its links around it, and a tap moves along', async () => {
    mockParams = { id: PLAN, card: 'c1' };
    mockRows.set(PLAN_LINKS_SQL, [{ id: 'l1', from_card_id: 'c2', to_card_id: 'c1', relation: 'prerequisite', note: null, created_by: USER }]);
    mockRows.set(CARD_LINKS_SQL, [
      { id: 'l1', from_card_id: 'c2', to_card_id: 'c1', relation: 'prerequisite', note: null, created_by: USER, other_card_id: 'c2', other_question: 'What are ribosomes for?' },
    ]);
    const renderer = await render(screen('../../app/(app)/plans/[id]/map'));
    // Draw at a phone's width.
    await act(async () => {
      for (const node of renderer.root.findAll((n) => typeof n.type === 'string' && typeof n.props.onLayout === 'function')) {
        node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 350, height: 0 } }, persist: () => undefined });
      }
    });
    expect(renderer.root.findAll((node) => node.props.accessibilityLabel === 'In the middle: What makes ATP?' && typeof node.type === 'string')).toHaveLength(1);
    await tap(renderer, 'Learn this first: What are ribosomes for?');
    expect(renderer.root.findAll((node) => node.props.accessibilityLabel === 'In the middle: What are ribosomes for?' && typeof node.type === 'string')).toHaveLength(1);
  });

  it('linking "Learn this first" stores a prerequisite from the other card to the middle one', async () => {
    mockParams = { id: PLAN, card: 'c1' };
    const renderer = await render(screen('../../app/(app)/plans/[id]/map'));
    expect(textOf(renderer)).toContain('This card has no links yet.');
    await tap(renderer, 'Link another card');
    await tap(renderer, 'Learn this first');
    await tap(renderer, 'Why do cells divide?');
    expect(repo.createCardLink).toHaveBeenCalledWith(
      expect.objectContaining({ fromCardId: 'c3', toCardId: 'c1', relation: 'prerequisite', createdBy: USER }),
    );
  });
});
