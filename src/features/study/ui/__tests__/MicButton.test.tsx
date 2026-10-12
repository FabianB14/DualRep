import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { AccessibilityInfo, Animated, StyleSheet } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { ThemeProvider, touch } from '@/theme';

import type { DictationStatus } from '../../useDictation';
import { MicButton } from '../MicButton';

jest.mock('expo-haptics', () => ({
  performAndroidHapticsAsync: jest.fn(async () => undefined),
  selectionAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: {},
  NotificationFeedbackType: {},
  AndroidHaptics: {},
}));

const mounted: ReactTestRenderer[] = [];

async function render(status: DictationStatus, onPress = jest.fn(), level = new Animated.Value(0.5)): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <ThemeProvider>
        <MicButton status={status} level={level} onPress={onPress} />
      </ThemeProvider>,
    );
  });
  mounted.push(renderer!);
  return renderer!;
}

function button(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.find((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'button');
}

afterEach(() => {
  for (const renderer of mounted.splice(0)) act(() => renderer.unmount());
  jest.restoreAllMocks();
});

describe('MicButton', () => {
  it('says what a tap does, in words, with its state', async () => {
    const cases: [DictationStatus, string, object][] = [
      ['off', 'Start speaking', { disabled: false, busy: false }],
      ['starting', 'Pause speaking', { disabled: false, busy: true }],
      ['listening', 'Pause speaking', { disabled: false, busy: false }],
      ['stopping', 'Finishing the last words', { disabled: true, busy: true }],
    ];
    for (const [status, label, state] of cases) {
      const node = button(await render(status));
      expect([status, node.props.accessibilityLabel, node.props.accessibilityState]).toEqual([status, label, state]);
    }
  });

  it('is a 56 dp target and calls back on a tap', async () => {
    const onPress = jest.fn();
    const renderer = await render('off', onPress);
    const node = button(renderer);
    expect(StyleSheet.flatten(node.props.style).minHeight).toBe(touch.comfortable);
    expect(touch.comfortable).toBe(56);
    await act(async () => node.props.onClick({}));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('the voice dot grows with the level, and stays still with Reduce motion on', async () => {
    const dot = (renderer: ReactTestRenderer) =>
      renderer.root.find((node) => typeof node.type === 'string' && StyleSheet.flatten(node.props.style)?.borderRadius === 6);
    const moving = await render('listening', jest.fn(), new Animated.Value(1));
    expect(StyleSheet.flatten(dot(moving).props.style).transform).toEqual([{ scale: 1.8 }]);
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const still = await render('listening', jest.fn(), new Animated.Value(1));
    expect(StyleSheet.flatten(dot(still).props.style).transform).toEqual([{ scale: 1 }]);
  });
});
