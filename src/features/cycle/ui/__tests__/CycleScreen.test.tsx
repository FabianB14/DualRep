/**
 * The cycle screen in every phase, with useCycle replaced by a stub that hands the screen real machine
 * states (see testing/cycleFixtures.ts) and records the actions. The local database is empty (no
 * profile, no setups, no history, offline): what a phone has before its first sync.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AccessibilityInfo, BackHandler, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { motion, ThemeProvider } from '@/theme';

import { currentStation, type CycleState, type MoveState } from '../../cycleMachine';
import type { UseCycleResult } from '../../useCycle';
import { CycleScreen } from '../CycleScreen';
import { FOCUS_RING_MAX } from '../FocusDial';
import { MORPH_LAYOUT_WAIT_MS } from '../HandoffMorph';
import {
  after,
  circuitFor,
  endsAt,
  finishedState,
  focusState,
  HOME_PLAN,
  logEvent,
  MIN,
  moveAfter,
  moveOnlyState,
  returnState,
  T0,
  USER,
  withFirstItem,
} from '../testing/cycleFixtures';

// Reanimated 4's jest mock (animations finish at once), on the worklets runtime's own mock.
jest.mock('react-native-worklets', () => jest.requireActual('react-native-worklets/src/mock'));
jest.mock('react-native-reanimated', () => jest.requireActual('react-native-reanimated/mock'));

const mockEmpty: unknown[] = [];
let mockLoading = false;
jest.mock('@powersync/react-native', () => ({ useQuery: () => ({ data: mockEmpty, isLoading: mockLoading }) }));
jest.mock('../../../../db/database', () => ({ db: {} }));
jest.mock('../../../../auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: '11111111-1111-4111-8111-111111111111' } }),
}));
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) },
}));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: jest.fn() }));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => undefined),
  selectionAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  performAndroidHapticsAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  AndroidHaptics: {},
}));
let mockPermission = 'undetermined';
jest.mock('../../../timer/notifications', () => ({
  getNotificationPermission: jest.fn(async () => mockPermission),
  requestNotificationPermission: jest.fn(async () => 'denied'),
}));
jest.mock('../../../setups/setupsRepo', () => ({ createSetupFromTemplate: jest.fn(async () => 'setup-new') }));

type AnyMock = jest.Mock<(...args: any[]) => any>;

/** What the stubbed useCycle returns; tests set `state` and `now`. */
const mockCycle = {
  state: null as CycleState | null,
  loading: false,
  error: null as string | null,
  now: T0,
  unit: 'lb' as 'lb' | 'kg',
  start: jest.fn(),
  startMoveOnly: jest.fn(async () => true),
  pause: jest.fn(),
  resume: jest.fn(),
  endBlock: jest.fn(),
  logSet: jest.fn(),
  skipRest: jest.fn(),
  skipExercise: jest.fn(),
  swapExercise: jest.fn(async (_itemIndex: number, _replacement: { id: string }) => undefined),
  rateBlock: jest.fn(),
  finishMove: jest.fn(),
  skipMove: jest.fn(),
  startNow: jest.fn(),
  finish: jest.fn(),
  dismissSummary: jest.fn(),
};
jest.mock('../../useCycle', () => ({ useCycle: (): UseCycleResult => mockCycle as unknown as UseCycleResult }));

const mockRouter = (jest.requireMock('expo-router') as { router: Record<string, AnyMock> }).router;
const keepAwake = (jest.requireMock('expo-keep-awake') as { useKeepAwake: AnyMock }).useKeepAwake;
const notifications = jest.requireMock('../../../timer/notifications') as Record<string, AnyMock>;
const setupsRepo = jest.requireMock('../../../setups/setupsRepo') as Record<string, AnyMock>;

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 24, left: 0, right: 0, bottom: 16 } };

const mounted: ReactTestRenderer[] = [];

function tree(mode: 'study' | 'move' = 'study') {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>
        <CycleScreen mode={mode} />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

async function render(mode: 'study' | 'move' = 'study'): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(tree(mode));
  });
  mounted.push(renderer!);
  return renderer!;
}

/** The cycle moved on: re-render with the new state and clock (as useCycle would). */
async function show(renderer: ReactTestRenderer, state: CycleState | null, now: number = mockCycle.now) {
  mockCycle.state = state;
  mockCycle.now = now;
  await act(async () => renderer.update(tree()));
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

/** The pressable host view with this accessibility label. */
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

function byTestId(renderer: ReactTestRenderer, testID: string): ReactTestInstance[] {
  return renderer.root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID);
}

/**
 * Lays out the handoff's card slot: React Native's jest View never answers measureInWindow, so the
 * slot's View is told where it is on screen, then its onLayout fires as on a phone.
 */
async function layOutCard(renderer: ReactTestRenderer) {
  const slot = renderer.root.find(
    (node) => typeof node.type !== 'string' && node.props.testID === 'handoff-slot' && node.instance?.measureInWindow,
  );
  (slot.instance.measureInWindow as AnyMock).mockImplementation(
    (callback: (x: number, y: number, width: number, height: number) => void) => callback(20, 120, 350, 300),
  );
  await act(async () => slot.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 350, height: 300 } } }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCycle.state = null;
  mockCycle.now = T0;
  mockCycle.error = null;
  mockCycle.unit = 'lb';
  mockPermission = 'undetermined';
  mockLoading = false;
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) act(() => renderer.unmount());
  jest.useRealTimers();
});

describe('loading', () => {
  it('waits for the saved cycle', async () => {
    const renderer = await render();
    expect(renderer.root.findAll((node) => node.props.accessibilityLabel === 'Loading').length).toBeGreaterThan(0);
    expect(keepAwake).not.toHaveBeenCalled();
  });
});

describe('start panel (idle) with an empty database', () => {
  it('starts from the defaults once the user picks where they train', async () => {
    mockCycle.state = after(focusState(), { type: 'finish', at: T0 + MIN }, { type: 'dismiss_summary' });
    const renderer = await render();
    const text = textOf(renderer);
    expect(text).toContain('Study block');
    expect(text).toContain('25 min');
    expect(text).toContain('Full body');
    expect(text).toContain('Home, just my body');
    expect(text).toContain('Gym');
    expect(text).toContain('asks to send one alert');
    expect(control(renderer, 'Start focus block').props.accessibilityState).toMatchObject({ disabled: true });

    await press(renderer, 'Home, just my body, No equipment needed');
    expect(setupsRepo.createSetupFromTemplate).toHaveBeenCalledWith(USER, 'home_bodyweight', [], { makeDefault: true });
    await press(renderer, 'Increase Focus block');
    await press(renderer, '5-minute circuit');
    expect(control(renderer, 'Start focus block').props.accessibilityState).toMatchObject({ disabled: false });

    await press(renderer, 'Start focus block');
    // First ever start: ask for the alert permission, then start (a "no" does not stop the block).
    expect(notifications.requestNotificationPermission).toHaveBeenCalledTimes(1);
    expect(mockCycle.start).toHaveBeenCalledWith({
      focusSubject: '',
      blockMinutes: 30,
      presetId: expect.any(String),
      split: { lower: 25, upper: 50, core: 25, cardio: 0 },
      setupId: 'setup-new',
      location: 'home',
      equipment: [],
      moveKind: 'micro',
      moveMinutes: 5,
    });
  });

  it('offers the one-tap setups only once the setups have been read (no second setup by mistake)', async () => {
    mockLoading = true;
    mockCycle.state = after(focusState(), { type: 'finish', at: T0 + MIN }, { type: 'dismiss_summary' });
    const renderer = await render();
    expect(textOf(renderer)).not.toContain('Home, just my body');
    expect(textOf(renderer)).not.toContain('Pick where you’re training first');
    mockLoading = false;
    await show(renderer, mockCycle.state);
    expect(textOf(renderer)).toContain('Home, just my body');
  });

  it('waits for the one-tap setup to be saved before starting, so the workout points at it', async () => {
    let saved: (id: string) => void = () => undefined;
    setupsRepo.createSetupFromTemplate.mockImplementationOnce(() => new Promise<string>((resolve) => (saved = resolve)));
    mockCycle.state = after(focusState(), { type: 'finish', at: T0 + MIN }, { type: 'dismiss_summary' });
    const renderer = await render();
    await press(renderer, 'Gym, Machines, barbells, dumbbells and more');
    expect(control(renderer, 'Start focus block').props.accessibilityState).toMatchObject({ disabled: true });
    await act(async () => saved('setup-gym'));
    await press(renderer, 'Start focus block');
    expect(mockCycle.start).toHaveBeenCalledWith(expect.objectContaining({ setupId: 'setup-gym', location: 'gym' }));
  });

  it('does not ask again once notifications are denied, and says so quietly', async () => {
    mockPermission = 'denied';
    mockCycle.state = after(focusState(), { type: 'finish', at: T0 + MIN }, { type: 'dismiss_summary' });
    const renderer = await render();
    expect(textOf(renderer)).toContain('Alerts are off');
    await press(renderer, 'Gym, Machines, barbells, dumbbells and more');
    await press(renderer, 'Full session');
    await press(renderer, '60-minute session');
    await press(renderer, 'Start focus block');
    expect(notifications.requestNotificationPermission).not.toHaveBeenCalled();
    expect(mockCycle.start).toHaveBeenCalledWith(expect.objectContaining({ location: 'gym', moveKind: 'full', moveMinutes: 60 }));
  });

  it('changes the preset for this cycle only', async () => {
    mockCycle.state = after(focusState(), { type: 'finish', at: T0 + MIN }, { type: 'dismiss_summary' });
    const renderer = await render();
    await press(renderer, 'Preset: Full body');
    await press(renderer, 'All upper body, Upper 100%');
    expect(textOf(renderer)).toContain('Preset: All upper body');
    await press(renderer, 'Gym, Machines, barbells, dumbbells and more');
    await press(renderer, 'Start focus block');
    expect(mockCycle.start).toHaveBeenCalledWith(
      expect.objectContaining({ split: { lower: 0, upper: 100, core: 0, cardio: 0 }, location: 'gym' }),
    );
  });

  it('"Just train" starts a workout on its own', async () => {
    mockCycle.state = after(focusState(), { type: 'finish', at: T0 + MIN }, { type: 'dismiss_summary' });
    const renderer = await render('move');
    const text = textOf(renderer);
    expect(text).toContain('Just train');
    expect(text).not.toContain('What are you studying?');
    await press(renderer, 'Home, just my body, No equipment needed');
    await press(renderer, 'Start workout');
    expect(mockCycle.startMoveOnly).toHaveBeenCalledWith(expect.objectContaining({ location: 'home', moveKind: 'micro', moveMinutes: 10 }));
    expect(notifications.requestNotificationPermission).not.toHaveBeenCalled();

    mockCycle.startMoveOnly.mockResolvedValueOnce(false);
    await press(renderer, 'Start workout');
    expect(textOf(renderer)).toContain('Couldn’t put a workout together');
  });
});

describe('focus', () => {
  it('shows the ring, the time left and the preview, and does not keep the screen awake', async () => {
    const focus = focusState();
    mockCycle.state = focus;
    mockCycle.now = T0 + 60_000;
    const renderer = await render();
    const text = textOf(renderer);
    expect(text).toContain('Focus block 1');
    expect(text).toContain('Biology, chapter 4');
    expect(text).toContain('24:00');
    expect(text).toContain(`Next: 10-min home circuit · ${focus.circuit!.items[0].name} first`);
    const ring = renderer.root.find((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'progressbar');
    expect(ring.props.accessibilityLabel).toBe('Focus timer');
    expect(ring.props.accessibilityValue).toEqual({ text: '24 minutes left' });
    expect(ring.props.accessibilityLiveRegion).toBe('polite');
    expect(keepAwake).not.toHaveBeenCalled();

    await press(renderer, 'Pause');
    expect(mockCycle.pause).toHaveBeenCalled();
    await press(renderer, 'End block early');
    expect(mockCycle.endBlock).toHaveBeenCalled();
    await press(renderer, 'Finish for now');
    expect(mockCycle.finish).toHaveBeenCalled();
  });

  it('offers Resume while paused', async () => {
    mockCycle.state = after(focusState(), { type: 'pause', at: T0 + 2 * MIN });
    mockCycle.now = T0 + 10 * MIN;
    const renderer = await render();
    expect(textOf(renderer)).toContain('23:00');
    expect(textOf(renderer)).toContain('Paused');
    await press(renderer, 'Resume');
    expect(mockCycle.resume).toHaveBeenCalled();
  });

  it('says the workout is being prepared when the block ended before the circuit was ready', async () => {
    const waiting = after(focusState({ circuit: null }), { type: 'end_block', at: T0 + MIN });
    expect(waiting.phase).toBe('focus');
    mockCycle.state = waiting;
    const renderer = await render();
    expect(textOf(renderer)).toContain('Getting your workout ready');
    expect(has(renderer, 'Pause')).toBe(false);
  });

  it('notes quietly that alerts are off when they are', async () => {
    mockPermission = 'denied';
    mockCycle.state = focusState();
    const renderer = await render();
    expect(textOf(renderer)).toContain('Alerts are off');
  });
});

describe('the handoff', () => {
  it('morphs the ring into the first exercise card with no tap when the block runs out on screen', async () => {
    jest.useFakeTimers();
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const focus = focusState();
    const end = endsAt(focus);
    mockCycle.state = focus;
    mockCycle.now = end - 1_000;
    const renderer = await render();
    expect(textOf(renderer)).toContain('0:01');

    const move = moveAfter(focus);
    const first = move.circuit.items[0];
    await show(renderer, move, end);
    // The move block is live at once: the card, the Done button, keep-awake; the ring copy morphs.
    expect(byTestId(renderer, 'handoff-morph')).toHaveLength(1);
    expect(byTestId(renderer, 'handoff-ring')).toHaveLength(1);
    expect(textOf(renderer)).toContain(first.name);
    expect(has(renderer, `Done: log ${textForTarget(move)}`)).toBe(true);
    expect(keepAwake).toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith(expect.stringContaining(`Time to move: ${first.name}`));

    // The card is laid out and measured: the morph runs, then the ring copy is gone.
    await layOutCard(renderer);
    // Past the wait for layout: the morph itself is running (motion.duration.morph).
    await act(async () => {
      jest.advanceTimersByTime(MORPH_LAYOUT_WAIT_MS + 50);
    });
    expect(byTestId(renderer, 'handoff-morph')).toHaveLength(1);
    await act(async () => {
      jest.advanceTimersByTime(motion.duration.morph);
    });
    expect(byTestId(renderer, 'handoff-morph')).toHaveLength(0);
    expect(textOf(renderer)).toContain(first.name);

    // It never replays for the same workout.
    await show(renderer, move, end + 1_000);
    expect(byTestId(renderer, 'handoff-morph')).toHaveLength(0);
  });

  it('cross-fades instead of morphing when the system asks for reduced motion', async () => {
    jest.useFakeTimers();
    // Read once when the theme mounts.
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValueOnce(true);
    const focus = focusState();
    mockCycle.state = focus;
    mockCycle.now = endsAt(focus) - 1_000;
    const renderer = await render();
    await show(renderer, moveAfter(focus), endsAt(focus));
    await layOutCard(renderer);
    // The ring stays its own size where it was (no growing shape, no color change) while it fades.
    const [shape] = byTestId(renderer, 'handoff-shape');
    const style = StyleSheet.flatten(shape.props.style) as Record<string, unknown>;
    expect(style.width).toBe(FOCUS_RING_MAX);
    expect(style.backgroundColor).toBeUndefined();
    await act(async () => {
      jest.advanceTimersByTime(motion.duration.fast + 50);
    });
    expect(byTestId(renderer, 'handoff-morph')).toHaveLength(0);
  });

  it('never leaves the screen behind the ring when the card cannot be measured', async () => {
    jest.useFakeTimers();
    const focus = focusState();
    mockCycle.state = focus;
    mockCycle.now = T0 + 5 * MIN;
    const renderer = await render();
    await show(renderer, after(focus, { type: 'end_block', at: T0 + 5 * MIN }), T0 + 5 * MIN);
    expect(byTestId(renderer, 'handoff-morph')).toHaveLength(1);
    await act(async () => {
      jest.advanceTimersByTime(MORPH_LAYOUT_WAIT_MS + 1);
    });
    expect(byTestId(renderer, 'handoff-morph')).toHaveLength(0);
  });

  it('shows the card directly when the app is opened after the block already ended', async () => {
    const focus = focusState();
    const move = moveAfter(focus);
    mockCycle.state = move;
    mockCycle.now = endsAt(focus) + 20 * MIN;
    const renderer = await render();
    expect(byTestId(renderer, 'handoff-morph')).toHaveLength(0);
    expect(textOf(renderer)).toContain(move.circuit.items[0].name);
    expect(keepAwake).toHaveBeenCalled();
  });

  it('does not animate a block that ended while the app was in the background', async () => {
    const focus = focusState();
    mockCycle.state = focus;
    mockCycle.now = T0 + 3 * MIN;
    const renderer = await render();
    // Back in the foreground 30 minutes later: the clock jumps, and the move block is already there.
    await show(renderer, moveAfter(focus), T0 + 33 * MIN);
    expect(byTestId(renderer, 'handoff-morph')).toHaveLength(0);
  });
});

/** The Done button's target words for the current station. */
function textForTarget(state: MoveState): string {
  const station = currentStation(state)!;
  const amount = station.item.measure === 'time' ? `${station.target} s` : `${station.target} reps`;
  return station.targetWeightLbs ? `${amount} at ${station.targetWeightLbs} lb` : amount;
}

describe('move', () => {
  it('logs the set as the target with one tap', async () => {
    const move = moveAfter(focusState());
    mockCycle.state = move;
    mockCycle.now = endsAt(focusState()) + 5_000;
    const renderer = await render();
    expect(textOf(renderer)).toContain(`Round 1 of ${move.circuit.rounds}`);
    await press(renderer, `Done: log ${textForTarget(move)}`);
    expect(mockCycle.logSet).toHaveBeenCalledWith({ expectedSetIndex: 0 });
  });

  it('adjusts reps, weight and effort before Done, in the user’s unit', async () => {
    const circuit = withFirstItem(circuitFor(), { measure: 'reps', targetReps: 10, targetSeconds: null, targetWeightLbs: 25 });
    const move = moveAfter(focusState({ circuit }));
    mockCycle.state = move;
    const renderer = await render();
    const text = textOf(renderer);
    expect(text).toContain('10 reps · 25 lb');
    await press(renderer, 'Decrease Reps');
    await press(renderer, 'Increase Weight');
    await press(renderer, 'Solid');
    await press(renderer, 'Done: log 9 reps at 30 lb');
    expect(mockCycle.logSet).toHaveBeenCalledWith({ expectedSetIndex: 0, done: 9, weightLbs: 30, rpe: 8 });
  });

  it('shows weights in kilograms for a kg profile', async () => {
    mockCycle.unit = 'kg';
    const circuit = withFirstItem(circuitFor(), { measure: 'reps', targetReps: 8, targetSeconds: null, targetWeightLbs: 44.0924524 });
    mockCycle.state = moveAfter(focusState({ circuit }));
    const renderer = await render();
    expect(textOf(renderer)).toContain('8 reps · 20 kg');
    await press(renderer, 'Increase Weight');
    await press(renderer, 'Done: log 8 reps at 22.5 kg');
    const [actual] = mockCycle.logSet.mock.calls[0] as [{ weightLbs: number }];
    expect(actual.weightLbs).toBeCloseTo(22.5 * 2.20462262185, 6);
  });

  it('after a set: the spotter’s note, the rest countdown and its skip', async () => {
    const move = moveAfter(focusState());
    const at = endsAt(focusState()) + MIN;
    const logged = after(move, logEvent(move, at)) as MoveState;
    expect(logged.rest).not.toBeNull();
    mockCycle.state = logged;
    mockCycle.now = at + 2_000;
    const renderer = await render();
    const text = textOf(renderer);
    expect(text).toContain(`Spotter · ${move.circuit.items[0].name}`);
    expect(text).toContain(logged.lastAdvice!.advice.message);
    expect(text).toContain('Rest 0:');
    await press(renderer, 'Skip rest');
    expect(mockCycle.skipRest).toHaveBeenCalled();
    // The next set's Done guards against a stale tap.
    await press(renderer, `Done: log ${textForTarget(logged)}`);
    expect(mockCycle.logSet).toHaveBeenCalledWith({ expectedSetIndex: 1 });
  });

  it('swaps or skips the current exercise', async () => {
    const move = moveAfter(focusState());
    mockCycle.state = move;
    const renderer = await render();
    await press(renderer, 'Swap');
    const text = textOf(renderer);
    expect(text).toContain('Swap for');
    const [option] = renderer.root.findAll(
      (node) => typeof node.type === 'string' && node.props.accessibilityHint === 'Swaps the current exercise for this one',
    );
    await act(async () => option.props.onClick({}));
    expect(mockCycle.swapExercise).toHaveBeenCalledWith(0, expect.objectContaining({ id: expect.any(String) }));
    const [, replacement] = mockCycle.swapExercise.mock.calls[0];
    expect(move.circuit.items.map((item) => item.exerciseId)).not.toContain(replacement.id);
    expect(textOf(renderer)).not.toContain('Swap for');

    await press(renderer, 'Skip this exercise');
    expect(mockCycle.skipExercise).toHaveBeenCalled();
  });

  it('asks how the focus block went, without blocking anything', async () => {
    mockCycle.state = moveAfter(focusState());
    const renderer = await render();
    expect(textOf(renderer)).toContain('How was that focus block?');
    await press(renderer, '4, good');
    expect(mockCycle.rateBlock).toHaveBeenCalledWith(4);
    await press(renderer, 'Skip workout');
    expect(mockCycle.skipMove).toHaveBeenCalled();
  });

  it('"Just train" has no block to rate and ends the workout itself', async () => {
    const move = moveOnlyState();
    mockCycle.state = after(move, logEvent(move, T0 + MIN));
    mockCycle.now = T0 + 2 * MIN;
    const renderer = await render();
    expect(textOf(renderer)).not.toContain('How was that focus block?');
    expect(has(renderer, 'Finish for now')).toBe(false);
    await press(renderer, 'End workout');
    expect(mockCycle.finishMove).toHaveBeenCalled();
  });

  it('works with timed exercises', async () => {
    const circuit = withFirstItem(circuitFor(), { measure: 'time', targetReps: null, targetSeconds: 40, targetWeightLbs: null });
    mockCycle.state = moveAfter(focusState({ circuit }));
    const renderer = await render();
    expect(textOf(renderer)).toContain('40 s');
    await press(renderer, 'Increase Seconds');
    await press(renderer, 'Done: log 45 s');
    expect(mockCycle.logSet).toHaveBeenCalledWith({ expectedSetIndex: 0, done: 45 });
  });
});

describe('return', () => {
  it('counts down to the next block, with Start now and Finish for now', async () => {
    const back = returnState();
    mockCycle.state = back;
    mockCycle.now = (back.countdown.endsAt ?? T0) - 30_000;
    const renderer = await render();
    const text = textOf(renderer);
    expect(text).toContain('Next focus block in 0:30');
    expect(text).toContain('So far: 1 focus block · 25 min · 1 set');
    expect(keepAwake).not.toHaveBeenCalled();
    await press(renderer, 'Start now');
    expect(mockCycle.startNow).toHaveBeenCalled();
    await press(renderer, 'Finish for now');
    expect(mockCycle.finish).toHaveBeenCalled();
    await press(renderer, '5, great');
    expect(mockCycle.rateBlock).toHaveBeenCalledWith(5);
  });
});

describe('finish', () => {
  it('sums up the cycle, then goes back to Today', async () => {
    mockCycle.state = finishedState();
    const renderer = await render();
    const text = textOf(renderer);
    expect(text).toContain('Nice work');
    expect(text).toContain('focus minutes');
    await press(renderer, 'Back to Today');
    expect(mockCycle.dismissSummary).toHaveBeenCalled();
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it("Android's back button leaves the same way, so Home's next start does not reopen the old summary", async () => {
    let onBack: (() => boolean | null | undefined) | null = null;
    const remove = jest.fn();
    const listen = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_name, handler) => {
      onBack = handler as () => boolean | null | undefined;
      return { remove };
    });
    mockCycle.state = finishedState();
    const renderer = await render();
    let handled: boolean | null | undefined;
    act(() => {
      handled = onBack?.();
    });
    expect(handled).toBe(true);
    expect(mockCycle.dismissSummary).toHaveBeenCalledTimes(1);
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    // The start panel replaces the summary: the back button is the system's again.
    await show(renderer, after(finishedState(), { type: 'dismiss_summary' }));
    expect(remove).toHaveBeenCalled();
    listen.mockRestore();
  });

  it('error from saving is shown in every phase', async () => {
    mockCycle.error = "Couldn't save on this phone. Trying again…";
    mockCycle.state = focusState({ plan: HOME_PLAN });
    const renderer = await render();
    expect(textOf(renderer)).toContain("Couldn't save on this phone");
  });
});
