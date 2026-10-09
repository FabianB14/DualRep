/**
 * The focus screen of a cycle that studies a plan: the ring moves up and shrinks, the study panel
 * (replaced here by a stub that records what it is given) fills the screen under it, and the timer,
 * Pause / End block early / Finish and the zero-tap handoff work as without a plan. Without a plan
 * the panel never mounts.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AccessibilityInfo, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { StudyPanelProps } from '@/features/study/ui/StudyPanel';
import { motion, ThemeProvider } from '@/theme';

import type { CycleState } from '../../cycleMachine';
import type { UseCycleResult } from '../../useCycle';
import { CycleScreen } from '../CycleScreen';
import { STUDY_RING_SIZE } from '../FocusView';
import { after, endsAt, focusState, HOME_PLAN, MIN, moveAfter, T0 } from '../testing/cycleFixtures';

jest.mock('react-native-worklets', () => jest.requireActual('react-native-worklets/src/mock'));
jest.mock('react-native-reanimated', () => jest.requireActual('react-native-reanimated/mock'));
jest.mock('@powersync/react-native', () => ({ useQuery: () => ({ data: [], isLoading: false }) }));
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
jest.mock('../../../timer/notifications', () => ({
  getNotificationPermission: jest.fn(async () => 'granted'),
  requestNotificationPermission: jest.fn(async () => 'granted'),
}));
jest.mock('../../../study/hooks', () => ({ usePlans: () => ({ plans: [], isLoading: false }) }));
const mockPanels: StudyPanelProps[] = [];
jest.mock('../../../study/ui/StudyPanel', () => ({
  StudyPanel: (props: StudyPanelProps) => {
    mockPanels.push(props);
    return null;
  },
}));

const mockCycle = {
  state: null as CycleState | null,
  loading: false,
  error: null as string | null,
  now: T0,
  unit: 'lb' as const,
  start: jest.fn(),
  startMoveOnly: jest.fn(async () => true),
  pause: jest.fn(),
  resume: jest.fn(),
  endBlock: jest.fn(),
  logSet: jest.fn(),
  skipRest: jest.fn(),
  skipExercise: jest.fn(),
  swapExercise: jest.fn(async () => undefined),
  rateBlock: jest.fn(),
  finishMove: jest.fn(),
  skipMove: jest.fn(),
  startNow: jest.fn(),
  finish: jest.fn(),
  dismissSummary: jest.fn(),
};
jest.mock('../../useCycle', () => ({ useCycle: (): UseCycleResult => mockCycle as unknown as UseCycleResult }));

type AnyMock = jest.Mock<(...args: any[]) => any>;

const PLAN_ID = '90000000-0000-4000-8000-000000000001';
const STUDY_PLAN = { ...HOME_PLAN, studyPlanId: PLAN_ID, studyFilter: 'newest' as const };
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 24, left: 0, right: 0, bottom: 16 } };
const mounted: ReactTestRenderer[] = [];

function tree() {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>
        <CycleScreen mode="study" />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

async function render(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(tree());
  });
  mounted.push(renderer!);
  return renderer!;
}

async function show(renderer: ReactTestRenderer, state: CycleState, now: number) {
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

async function press(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root.find(
    (node) => typeof node.type === 'string' && node.props.accessibilityLabel === label && typeof node.props.onClick === 'function',
  );
  await act(async () => button.props.onClick({}));
}

function byTestId(renderer: ReactTestRenderer, testID: string): ReactTestInstance[] {
  return renderer.root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID);
}

/** The ring's own disc (FocusDial's outer view): its width is the ring's size. */
function ringSize(renderer: ReactTestRenderer): number {
  const ring = renderer.root.find((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'progressbar');
  let node: ReactTestInstance | null = ring.parent;
  while (node) {
    const style = StyleSheet.flatten(node.props.style) as { width?: number; borderRadius?: number } | undefined;
    if (typeof node.type === 'string' && style?.width && style.borderRadius === style.width / 2) return style.width;
    node = node.parent;
  }
  throw new Error('no ring disc');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPanels.length = 0;
  mockCycle.state = null;
  mockCycle.now = T0;
  mockCycle.error = null;
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) act(() => renderer.unmount());
  jest.useRealTimers();
});

describe('a focus block with a study plan', () => {
  it('a smaller ring above the study panel, which gets the block, the timer and the plan', async () => {
    const focus = focusState({ plan: STUDY_PLAN });
    mockCycle.state = focus;
    mockCycle.now = T0 + MIN;
    const renderer = await render();
    const text = textOf(renderer);
    expect(text).toContain('Focus block 1');
    expect(text).toContain('Biology, chapter 4');
    expect(text).toContain('24:00');
    expect(text).toContain('Next: 10-min home circuit');
    expect(ringSize(renderer)).toBe(STUDY_RING_SIZE);
    expect(mockPanels.at(-1)).toEqual({
      planId: PLAN_ID,
      filter: 'newest',
      blockId: focus.blockId,
      blockMs: 25 * MIN,
      remainingMs: 24 * MIN,
      now: T0 + MIN,
      paused: false,
    });
  });

  it('Pause, End block early and Finish are where they were', async () => {
    mockCycle.state = focusState({ plan: STUDY_PLAN });
    const renderer = await render();
    await press(renderer, 'Pause');
    expect(mockCycle.pause).toHaveBeenCalled();
    await press(renderer, 'End block early');
    expect(mockCycle.endBlock).toHaveBeenCalled();
    await press(renderer, 'Finish for now');
    expect(mockCycle.finish).toHaveBeenCalled();
  });

  it('paused: the panel is told (it hides the card) and Resume is offered', async () => {
    mockCycle.state = after(focusState({ plan: STUDY_PLAN }), { type: 'pause', at: T0 + 2 * MIN });
    mockCycle.now = T0 + 10 * MIN;
    const renderer = await render();
    expect(textOf(renderer)).toContain('23:00');
    expect(mockPanels.at(-1)).toMatchObject({ paused: true, remainingMs: 23 * MIN });
    await press(renderer, 'Resume');
    expect(mockCycle.resume).toHaveBeenCalled();
  });

  it('once the block has ended the panel is gone (an open card is dropped)', async () => {
    mockCycle.state = after(focusState({ plan: STUDY_PLAN, circuit: null }), { type: 'end_block', at: T0 + MIN });
    const renderer = await render();
    expect(textOf(renderer)).toContain('Getting your workout ready');
    expect(mockPanels).toHaveLength(0);
  });

  it('the handoff still morphs with no tap, from the small ring', async () => {
    jest.useFakeTimers();
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValueOnce(true);
    const focus = focusState({ plan: STUDY_PLAN });
    const end = endsAt(focus);
    mockCycle.state = focus;
    mockCycle.now = end - 1_000;
    const renderer = await render();
    // The ring reports where it is, as on a phone.
    const wrapper = renderer.root
      .findAll(
        (node) =>
          typeof node.type !== 'string' &&
          node.props.collapsable === false &&
          typeof node.props.onLayout === 'function' &&
          node.instance?.measureInWindow &&
          node.findAll((child) => child.props.accessibilityRole === 'progressbar').length > 0,
      )
      .at(-1)!;
    (wrapper.instance.measureInWindow as AnyMock).mockImplementation(
      (callback: (x: number, y: number, width: number, height: number) => void) => callback(20, 80, STUDY_RING_SIZE, STUDY_RING_SIZE),
    );
    await act(async () => wrapper.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: STUDY_RING_SIZE, height: STUDY_RING_SIZE } } }));

    const move = moveAfter(focus);
    const panelsBefore = mockPanels.length;
    await show(renderer, move, end);
    expect(mockPanels).toHaveLength(panelsBefore);
    expect(byTestId(renderer, 'handoff-morph')).toHaveLength(1);
    expect(textOf(renderer)).toContain(move.circuit.items[0].name);
    const slot = renderer.root.find(
      (node) => typeof node.type !== 'string' && node.props.testID === 'handoff-slot' && node.instance?.measureInWindow,
    );
    (slot.instance.measureInWindow as AnyMock).mockImplementation(
      (callback: (x: number, y: number, width: number, height: number) => void) => callback(20, 120, 350, 300),
    );
    await act(async () => slot.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 350, height: 300 } } }));
    // Reduced motion: the ring copy fades where it was, at the small ring's size.
    const [shape] = byTestId(renderer, 'handoff-shape');
    expect((StyleSheet.flatten(shape.props.style) as { width?: number }).width).toBe(STUDY_RING_SIZE);
    await act(async () => {
      jest.advanceTimersByTime(motion.duration.fast + 50);
    });
    expect(byTestId(renderer, 'handoff-morph')).toHaveLength(0);
  });
});

describe('a focus block without a plan', () => {
  it('never mounts the study panel and keeps the big ring', async () => {
    mockCycle.state = focusState();
    mockCycle.now = T0 + MIN;
    const renderer = await render();
    expect(mockPanels).toHaveLength(0);
    expect(ringSize(renderer)).toBeGreaterThan(STUDY_RING_SIZE);
  });
});
