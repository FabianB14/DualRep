import { useRef } from 'react';
import { ActivityIndicator, View, useWindowDimensions } from 'react-native';

import { Button, Notice, Screen, Text } from '@/components';
import type { NotificationPermission } from '@/features/timer/notifications';
import { formatClock, isPaused, progress, remainingMs } from '@/features/timer/timerMath';
import { useTheme } from '@/theme';

import type { FocusState } from '../cycleMachine';
import { minutesLeftLabel, previewLine } from './cycleText';
import { FocusDial, focusRingSize, type WindowFrame } from './FocusDial';
import { TopBar } from './TopBar';

export type FocusViewProps = {
  state: FocusState;
  now: number;
  permission: NotificationPermission | null;
  error: string | null;
  onPause(): void;
  onResume(): void;
  onEndBlock(): void;
  onFinish(): void;
  /** Where the ring is on screen, so the handoff morph can start from it. */
  onRingFrame(frame: WindowFrame): void;
};

/**
 * The focus phase: a big ring with the time left, Pause/Resume and "End block early". Nothing here
 * keeps the screen awake: the phone may lock, the block-end alert (if allowed) rings, and the timer
 * is right whenever the screen comes back (it is read from the clock).
 */
export function FocusView({
  state,
  now,
  permission,
  error,
  onPause,
  onResume,
  onEndBlock,
  onFinish,
  onRingFrame,
}: FocusViewProps) {
  const { colors, space } = useTheme();
  const { width } = useWindowDimensions();
  const ringRef = useRef<View>(null);
  const size = focusRingSize(width);
  const left = remainingMs(state.timer, now);
  const paused = isPaused(state.timer);
  const ended = state.endedAt !== null;
  const subject = state.plan.focusSubject;

  const measureRing = () => {
    ringRef.current?.measureInWindow((x, y, w, h) => {
      if (w > 0 && h > 0) onRingFrame({ x, y, width: w, height: h });
    });
  };

  const footer = ended ? null : (
    <>
      {paused ? (
        <Button label="Resume" size="comfortable" onPress={onResume} />
      ) : (
        <Button label="Pause" variant="secondary" size="comfortable" onPress={onPause} />
      )}
      <Button
        label="End block early"
        variant="ghost"
        accessibilityHint="Ends this focus block now and starts your workout"
        onPress={onEndBlock}
      />
    </>
  );

  return (
    <Screen footer={footer}>
      <TopBar
        running
        title={`Focus block ${state.blockNumber}`}
        subtitle={subject || undefined}
        trailing={
          <Button
            label="Finish"
            variant="ghost"
            fullWidth={false}
            accessibilityLabel="Finish for now"
            accessibilityHint="Ends the cycle and shows a summary"
            onPress={onFinish}
          />
        }
      />
      {error ? <Notice tone="warning" message={error} /> : null}
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space[5] }}>
        <View ref={ringRef} collapsable={false} onLayout={measureRing}>
          <FocusDial
            size={size}
            progress={ended ? 0 : 1 - progress(state.timer, now)}
            clock={formatClock(ended ? 0 : left)}
            caption={ended ? 'Done' : paused ? 'Paused' : 'left'}
            accessibilityLabel="Focus timer"
            accessibilityValueText={ended ? 'Done' : `${paused ? 'Paused, ' : ''}${minutesLeftLabel(left)}`}
            accessibilityLiveRegion="polite"
          />
        </View>
        {ended ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <ActivityIndicator color={colors.body.solid} />
            <Text tone="secondary" accessibilityLiveRegion="polite">
              Getting your workout ready…
            </Text>
          </View>
        ) : (
          <Text tone="secondary" align="center">
            {previewLine(state.plan, state.circuit)}
          </Text>
        )}
      </View>
      {permission === 'denied' ? (
        <Notice
          title="Alerts are off"
          tone="neutral"
          message="The timer still runs here. Turn on notifications in Settings to get an alert when a block ends."
        />
      ) : null}
    </Screen>
  );
}
