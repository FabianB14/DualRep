import { describe, expect, it, jest } from '@jest/globals';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SetupNeeded } from '@/features/setup/SetupNeeded';
import { ThemeProvider } from '@/theme';

import { Button } from '../Button';
import { StatusPill } from '../StatusPill';
import { TextField } from '../TextField';

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

/** All text rendered under a node, joined. */
function textOf(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => (node.type as unknown) === 'Text')
    .map((node) => [node.props.children].flat().filter((c: unknown) => typeof c === 'string' || typeof c === 'number').join(''))
    .join(' | ');
}

describe('Button', () => {
  it('is an accessible button that calls onPress', () => {
    const onPress = jest.fn();
    const renderer = render(<Button label="Send code" onPress={onPress} />);
    const button = renderer.root.find((node) => node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function');
    expect(button.props.accessibilityLabel).toBe('Send code');
    act(() => button.props.onPress({}));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('meets the touch target size, larger for the primary action', () => {
    const regular = render(<Button label="A" />);
    const comfortable = render(<Button label="B" size="comfortable" />);
    const minHeight = (renderer: ReactTestRenderer) => {
      const node = renderer.root.find((n) => n.props.accessibilityRole === 'button' && typeof n.props.style === 'function');
      const style = [node.props.style({ pressed: false })].flat(Infinity) as ({ minHeight?: number } | false)[];
      return Math.max(...style.map((s) => (s ? (s.minHeight ?? 0) : 0)));
    };
    expect(minHeight(regular)).toBe(48);
    expect(minHeight(comfortable)).toBe(56);
  });

  it('reports busy and disabled while loading', () => {
    const renderer = render(<Button label="Saving" loading />);
    const button = renderer.root.find((node) => node.props.accessibilityRole === 'button' && node.props.accessibilityState);
    expect(button.props.accessibilityState).toEqual({ disabled: true, busy: true });
  });
});

describe('TextField', () => {
  it('labels the input and exposes the error to screen readers', () => {
    const renderer = render(<TextField label="Email address" error="Enter your email address." value="" />);
    const input = renderer.root.find((node) => node.props.accessibilityLabel === 'Email address' && 'editable' in node.props);
    expect(input.props.accessibilityHint).toBe('Enter your email address.');
    expect(textOf(renderer)).toContain('Enter your email address.');
  });
});

describe('StatusPill', () => {
  it('states the status in words', () => {
    const renderer = render(<StatusPill tone="success" label="Up to date" accessibilityLabel="Sync status: Up to date" />);
    expect(textOf(renderer)).toContain('Up to date');
    expect(renderer.root.findAll((node) => node.props.accessibilityLabel === 'Sync status: Up to date').length).toBeGreaterThan(0);
  });
});

describe('SetupNeeded', () => {
  it('lists missing and invalid variables with the reason', () => {
    const renderer = render(
      <SetupNeeded
        missing={['EXPO_PUBLIC_POWERSYNC_URL']}
        invalid={['EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY']}
        reasons={{ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'is a secret key' }}
      />,
    );
    const text = textOf(renderer);
    expect(text).toContain('Setup needed');
    expect(text).toContain('EXPO_PUBLIC_POWERSYNC_URL');
    expect(text).toContain('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
    expect(text).toContain('is a secret key');
    expect(text).toContain('docs/SETUP.md');
  });
});
