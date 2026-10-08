import { describe, expect, it, jest } from '@jest/globals';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { ThemeProvider } from '@/theme';

import { Chip } from '../Chip';
import { Glyph } from '../Glyph';
import { ListGroup, ListRow } from '../ListRow';
import { Notice } from '../Notice';
import { NumberedSteps } from '../NumberedSteps';
import { StatCard, statsSentence } from '../StatCard';
import { clampProgress, dashOffset, ProgressRing, ringGeometry } from '../ProgressRing';
import { Section } from '../Section';
import { SegmentedControl } from '../SegmentedControl';
import { Stepper, stepValue } from '../Stepper';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => undefined),
  selectionAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  performAndroidHapticsAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  AndroidHaptics: {},
}));

// Reanimated 4 needs its native worklets runtime, which jest does not have. This stand-in runs
// useAnimatedProps' worklet once and hands the result to the wrapped component as plain props, so the
// test sees what the UI thread would draw.
jest.mock('react-native-reanimated', () => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: {
      createAnimatedComponent:
        (Component: never) =>
        ({ animatedProps, ...rest }: { animatedProps?: object }) =>
          createElement(Component, { ...rest, ...animatedProps }),
    },
    useAnimatedProps: (worklet: () => object) => worklet(),
  };
});

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 24, left: 0, right: 0, bottom: 16 } };

function render(element: ReactElement): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>{element}</ThemeProvider>
      </SafeAreaProvider>,
    );
  });
  return renderer!;
}

/** All text rendered, joined. */
function textOf(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => (node.type as unknown) === 'Text')
    .map((node) => [node.props.children].flat().filter((c: unknown) => typeof c === 'string' || typeof c === 'number').join(''))
    .join(' | ');
}

/** The pressable host views (they carry onPress and an accessibilityRole). */
function pressables(renderer: ReactTestRenderer, role?: string): ReactTestInstance[] {
  return renderer.root.findAll(
    (node) =>
      typeof node.type === 'string' &&
      typeof node.props.onClick === 'function' &&
      (role === undefined || node.props.accessibilityRole === role),
  );
}

function byLabel(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  return renderer.root.find(
    (node) => typeof node.type === 'string' && node.props.accessibilityLabel === label && typeof node.props.onClick === 'function',
  );
}

function press(node: ReactTestInstance): void {
  act(() => node.props.onClick({}));
}

/** The largest minHeight in a host view's style (flattened). */
function minHeight(node: ReactTestInstance): number {
  const styles = [node.props.style].flat(Infinity) as ({ minHeight?: number; height?: number } | false | null)[];
  return Math.max(...styles.map((s) => (s ? (s.minHeight ?? s.height ?? 0) : 0)));
}

describe('stepValue', () => {
  const range = { min: 10, max: 50, step: 5 };

  it('moves by whole steps and stays in range', () => {
    expect(stepValue(25, 1, range)).toBe(30);
    expect(stepValue(25, -1, range)).toBe(20);
    expect(stepValue(25, 2, range)).toBe(35);
    expect(stepValue(50, 1, range)).toBe(50);
    expect(stepValue(10, -1, range)).toBe(10);
    expect(stepValue(45, 3, range)).toBe(50);
  });

  it('snaps off-grid values onto the grid in the direction of travel', () => {
    expect(stepValue(23, 1, range)).toBe(25);
    expect(stepValue(23, -1, range)).toBe(20);
    expect(stepValue(23, 0, range)).toBe(25);
    expect(stepValue(5, 0, range)).toBe(10);
    expect(stepValue(99, 0, range)).toBe(50);
    expect(stepValue(Number.NaN, 1, range)).toBe(15);
  });

  it('handles fractional steps without drift and a zero step', () => {
    expect(stepValue(2.5, 1, { min: 0, max: 10, step: 2.5 })).toBe(5);
    expect(stepValue(0.3, 1, { min: 0, max: 1, step: 0.1 })).toBe(0.4);
    expect(stepValue(3, 1, { min: 0, max: 10, step: 0 })).toBe(4);
  });
});

describe('Stepper', () => {
  it('has labelled − and + buttons that step the value', () => {
    const onChange = jest.fn();
    const renderer = render(
      <Stepper label="Block length" value={25} min={10} max={50} step={5} format={(v) => `${v} min`} onChange={onChange} />,
    );
    expect(textOf(renderer)).toContain('25 min');
    press(byLabel(renderer, 'Increase Block length'));
    expect(onChange).toHaveBeenLastCalledWith(30);
    press(byLabel(renderer, 'Decrease Block length'));
    expect(onChange).toHaveBeenLastCalledWith(20);
    // The value is announced with its label when it changes.
    const value = renderer.root.find((node) => node.props.accessibilityLabel === 'Block length: 25 min' && typeof node.type === 'string');
    expect(value.props.accessibilityLiveRegion).toBe('polite');
  });

  it('turns a button inactive at the end of the range, and both when disabled', () => {
    const onChange = jest.fn();
    const atMax = render(<Stepper label="Core" value={100} min={0} max={100} step={5} onChange={onChange} />);
    expect(byLabel(atMax, 'Increase Core').props.accessibilityState).toEqual({ disabled: true });
    expect(byLabel(atMax, 'Decrease Core').props.accessibilityState).toEqual({ disabled: false });
    const disabled = render(<Stepper label="Core" value={50} min={0} max={100} step={5} disabled onChange={onChange} />);
    expect(byLabel(disabled, 'Increase Core').props.accessibilityState).toEqual({ disabled: true });
    expect(byLabel(disabled, 'Decrease Core').props.accessibilityState).toEqual({ disabled: true });
  });

  it('buttons are at least 48 dp, 56 dp when comfortable', () => {
    const regular = render(<Stepper label="Reps" value={5} min={0} max={10} onChange={() => undefined} />);
    const comfortable = render(<Stepper label="Reps" value={5} min={0} max={10} size="comfortable" onChange={() => undefined} />);
    expect(minHeight(byLabel(regular, 'Increase Reps'))).toBe(48);
    expect(minHeight(byLabel(comfortable, 'Increase Reps'))).toBe(56);
  });
});

describe('Chip', () => {
  it('reports its state in the role that fits', () => {
    const onPress = jest.fn();
    const filter = render(<Chip label="Fits my setup" role="checkbox" selected onPress={onPress} />);
    const node = byLabel(filter, 'Fits my setup');
    expect(node.props.accessibilityRole).toBe('checkbox');
    expect(node.props.accessibilityState).toEqual({ disabled: false, checked: true });
    press(node);
    expect(onPress).toHaveBeenCalledTimes(1);

    const button = render(<Chip label="Preset: Full body" />);
    expect(byLabel(button, 'Preset: Full body').props.accessibilityState).toEqual({ disabled: false, selected: false });
  });

  it('shows a check mark when selected (not color alone) and is a 48 dp target', () => {
    const on = render(<Chip label="Squat" role="radio" selected />);
    const off = render(<Chip label="Squat" role="radio" />);
    const paths = (renderer: ReactTestRenderer) => renderer.root.findAll((node) => node.props.d !== undefined && typeof node.type !== 'string');
    expect(paths(on).length).toBeGreaterThan(0);
    expect(paths(off).length).toBe(0);
    expect(minHeight(byLabel(on, 'Squat'))).toBeGreaterThanOrEqual(48);
  });
});

describe('SegmentedControl', () => {
  it('is a radio group whose segments report checked and call onChange once', () => {
    const onChange = jest.fn();
    const renderer = render(
      <SegmentedControl
        label="Units"
        value="lb"
        onChange={onChange}
        options={[
          { value: 'lb', label: 'lb', accessibilityLabel: 'Pounds' },
          { value: 'kg', label: 'kg', accessibilityLabel: 'Kilograms' },
        ]}
      />,
    );
    expect(renderer.root.findAll((node) => node.props.accessibilityRole === 'radiogroup' && typeof node.type === 'string')).toHaveLength(1);
    const pounds = byLabel(renderer, 'Pounds');
    const kilograms = byLabel(renderer, 'Kilograms');
    expect(pounds.props.accessibilityState).toEqual({ checked: true, disabled: false });
    expect(kilograms.props.accessibilityState).toEqual({ checked: false, disabled: false });
    press(pounds);
    expect(onChange).not.toHaveBeenCalled();
    press(kilograms);
    expect(onChange).toHaveBeenCalledWith('kg');
    expect(minHeight(kilograms)).toBeGreaterThanOrEqual(48);
  });
});

describe('ListRow / ListGroup', () => {
  it('reads as one control with everything it shows', () => {
    const onPress = jest.fn();
    const renderer = render(<ListRow title="Home" subtitle="Home · just your body" badge="Default" value="2 items" onPress={onPress} />);
    const row = byLabel(renderer, 'Home, Default, 2 items, Home · just your body');
    expect(row.props.accessibilityRole).toBe('button');
    expect(minHeight(row)).toBeGreaterThanOrEqual(56);
    press(row);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('is a checkbox or radio with its checked state', () => {
    const box = render(<ListRow title="Dumbbells" accessory="checkbox" checked onPress={() => undefined} />);
    expect(byLabel(box, 'Dumbbells').props.accessibilityRole).toBe('checkbox');
    expect(byLabel(box, 'Dumbbells').props.accessibilityState).toEqual({ disabled: false, checked: true });
    const radio = render(<ListRow title="Full body" accessory="radio" onPress={() => undefined} />);
    expect(byLabel(radio, 'Full body').props.accessibilityRole).toBe('radio');
    expect(byLabel(radio, 'Full body').props.accessibilityState).toEqual({ disabled: false, checked: false });
  });

  it('keeps a trailing control outside the row so both are reachable', () => {
    const edit = jest.fn();
    const renderer = render(
      <ListRow title="Arms" onPress={() => undefined} trailing={<Chip label="Edit Arms" onPress={edit} />} />,
    );
    const row = byLabel(renderer, 'Arms');
    expect(row.findAll((node) => node.props.accessibilityLabel === 'Edit Arms')).toHaveLength(0);
    press(byLabel(renderer, 'Edit Arms'));
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it('is a plain text row without onPress', () => {
    const renderer = render(<ListRow title="Movement" value="Squat" />);
    expect(pressables(renderer)).toHaveLength(0);
    expect(textOf(renderer)).toContain('Squat');
  });

  it('separates rows with hairlines and skips empty children', () => {
    const renderer = render(
      <ListGroup title="More">
        <ListRow title="One" />
        {null}
        {false}
        <ListRow title="Two" />
        <ListRow title="Three" />
      </ListGroup>,
    );
    expect(textOf(renderer)).toContain('More');
    const separators = renderer.root.findAll(
      (node) => typeof node.type === 'string' && [node.props.style].flat().some((s: { height?: number } | undefined) => s?.height !== undefined && s.height < 1),
    );
    expect(separators).toHaveLength(2);
  });
});

describe('ProgressRing', () => {
  it('computes the ring geometry and dash offsets', () => {
    expect(ringGeometry(100, 10)).toEqual({ radius: 45, circumference: 2 * Math.PI * 45, center: 50 });
    expect(ringGeometry(4, 10).radius).toBe(0);
    const c = 100;
    expect(dashOffset(c, 0)).toBe(100);
    expect(dashOffset(c, 0.25)).toBe(75);
    expect(dashOffset(c, 1)).toBe(0);
    expect(dashOffset(c, 2)).toBe(0);
    expect(dashOffset(c, -1)).toBe(100);
    expect(dashOffset(c, 0.25, true)).toBe(-75);
    expect(clampProgress(Number.NaN)).toBe(0);
  });

  const arcs = (renderer: ReactTestRenderer) =>
    renderer.root.findAll((node) => typeof node.type === 'string' && node.props.strokeDashoffset !== undefined);

  it('draws the track and an arc for a number, with the percentage for screen readers', () => {
    const renderer = render(
      <ProgressRing size={200} strokeWidth={12} progress={0.25} accessibilityLabel="Focus block">
        {null}
      </ProgressRing>,
    );
    const ring = renderer.root.find((node) => node.props.accessibilityRole === 'progressbar' && typeof node.type === 'string');
    expect(ring.props.accessibilityLabel).toBe('Focus block');
    expect(ring.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 25 });
    const [arc] = arcs(renderer);
    const { circumference } = ringGeometry(200, 12);
    expect(arc.props.strokeDashoffset).toBeCloseTo(circumference * 0.75);
  });

  it('draws no arc at zero (a round cap would leave a dot)', () => {
    expect(arcs(render(<ProgressRing size={100} strokeWidth={8} progress={0} />))).toHaveLength(0);
  });

  it('takes a shared value for UI-thread animation, and a spoken value', () => {
    const shared = { value: 0.5 } as never;
    const renderer = render(
      <ProgressRing size={100} strokeWidth={10} progress={shared} counterClockwise accessibilityValueText="12 minutes left" />,
    );
    const [arc] = arcs(renderer);
    expect(arc.props.strokeDashoffset).toBeCloseTo(-ringGeometry(100, 10).circumference * 0.5);
    const ring = renderer.root.find((node) => node.props.accessibilityRole === 'progressbar' && typeof node.type === 'string');
    expect(ring.props.accessibilityValue).toEqual({ text: '12 minutes left' });
  });

  it('renders its children in the middle', () => {
    const renderer = render(
      <ProgressRing size={100} strokeWidth={10} progress={0.5}>
        <Section title="12:00">{null}</Section>
      </ProgressRing>,
    );
    expect(textOf(renderer)).toContain('12:00');
  });
});

describe('NumberedSteps', () => {
  it('numbers each step, and a screen reader hears number and step together', () => {
    const renderer = render(<NumberedSteps steps={['Stand tall.', 'Sit back.']} accent="body" />);
    expect(textOf(renderer)).toContain('Stand tall.');
    const items = renderer.root.findAll((node) => node.props.accessible === true && typeof node.type === 'string');
    expect(items.map((node) => node.props.accessibilityLabel)).toEqual(['1. Stand tall.', '2. Sit back.']);
    expect(renderer.root.find((node) => node.props.accessibilityRole === 'list' && typeof node.type === 'string')).toBeDefined();
  });
});

describe('StatCard', () => {
  const stats = [
    { value: 2, label: 'focus blocks' },
    { value: 50, label: 'focus minutes' },
    { value: 18, label: 'sets' },
  ];

  it('shows each number with its label', () => {
    const text = textOf(render(<StatCard stats={stats} />));
    for (const part of ['2', 'focus blocks', '50', 'focus minutes', '18', 'sets']) expect(text).toContain(part);
  });

  it('is one stop for a screen reader: the numbers as a sentence, or the label given', () => {
    const spoken = (element: ReactElement) =>
      render(element).root.find((node) => node.props.accessible === true && typeof node.type === 'string').props
        .accessibilityLabel;
    expect(statsSentence(stats)).toBe('2 focus blocks, 50 focus minutes, 18 sets.');
    expect(spoken(<StatCard stats={stats} />)).toBe('2 focus blocks, 50 focus minutes, 18 sets.');
    expect(spoken(<StatCard stats={stats} accessibilityLabel="Today: nothing yet" />)).toBe('Today: nothing yet');
  });
});

describe('Notice, Section and Glyph', () => {
  it('shows a title and message', () => {
    const renderer = render(<Notice tone="warning" title="Notifications are off" message="The timer still works." />);
    expect(textOf(renderer)).toContain('Notifications are off');
    expect(textOf(renderer)).toContain('The timer still works.');
  });

  it('can be a live region with its own spoken label (the spotter after each set)', () => {
    const renderer = render(
      <Notice title="Spotter · Goblet squat" message="Drop to 40 lb." accessibilityLabel="Spotter: drop to 40 lb." accessibilityLiveRegion="polite" />,
    );
    const box = renderer.root.find((node) => node.props.accessible === true && typeof node.type === 'string');
    expect(box.props.accessibilityLiveRegion).toBe('polite');
    expect(box.props.accessibilityLabel).toBe('Spotter: drop to 40 lb.');
  });

  it('marks the section title as a heading', () => {
    const renderer = render(
      <Section title="Weights" description="Pick a unit">
        {null}
      </Section>,
    );
    expect(renderer.root.findAll((node) => node.props.accessibilityRole === 'header' && typeof node.type === 'string')).toHaveLength(1);
    expect(textOf(renderer)).toContain('Pick a unit');
  });

  it('hides icons from screen readers', () => {
    const renderer = render(<Glyph name="check" color="#000000" />);
    const svg = renderer.root.find((node) => node.props.accessibilityElementsHidden === true);
    expect(svg.props.importantForAccessibility).toBe('no-hide-descendants');
  });
});
