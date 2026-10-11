import { useRef } from 'react';
import { ActivityIndicator, View, useWindowDimensions } from 'react-native';

import { Button, Notice, Screen, Text } from '@/components';
import { StudyPanel } from '@/features/study/ui/StudyPanel';
import type { NotificationPermission } from '@/features/timer/notifications';
import { formatClock, isPaused, progress, remainingMs } from '@/features/timer/timerMath';
import { useTheme } from '@/theme';

import { studyPlanOf, type FocusState } from '../cycleMachine';
import { minutesLeftLabel, previewLine } from './cycleText';
import { FocusDial, focusRingSize, type WindowFrame } from './FocusDial';
import { TopBar } from './TopBar';

/** The ring's size beside the study panel, in dp: the time stays readable, the card gets the room. */
export const STUDY_RING_SIZE = 120;

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
 *
 * With a study plan (Phase 2) the ring is smaller, at the top, and the quiz-first study panel fills
 * the screen under it; the ring still reports where it is, so the handoff morph grows from it. The
 * timer, the buttons and the handoff are the same; the panel goes away (with any card left open) as
 * soon as the block ends. Without a plan this screen is exactly Phase 1's.
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
  const study = studyPlanOf(state.plan);

  const measureRing = () => {
    ringRef.current?.measureInWindow((x, y, w, h) => {
      if (w > 0 && h > 0) onRingFrame({ x, y, width: w, height: h });
    });
  };

  const dial = (ringSize: number) => (
    <FocusDial
      size={ringSize}
      progress={ended ? 0 : 1 - progress(state.timer, now)}
      clock={formatClock(ended ? 0 : left)}
      caption={ended ? 'Done' : paused ? 'Paused' : 'left'}
      accessibilityLabel="Focus timer"
      accessibilityValueText={ended ? 'Done' : `${paused ? 'Paused, ' : ''}${minutesLeftLabel(left)}`}
      accessibilityLiveRegion="polite"
    />
  );

  // Beside the small ring the line may need to wrap.
  const preparing = (beside: boolean) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
      <ActivityIndicator color={colors.body.solid} />
      <Text tone="secondary" accessibilityLiveRegion="polite" style={beside ? { flexShrink: 1 } : undefined}>
        Getting your workout ready…
      </Text>
    </View>
  );

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
      {study ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[4] }}>
            <View ref={ringRef} collapsable={false} onLayout={measureRing}>
              {dial(STUDY_RING_SIZE)}
            </View>
            <View style={{ flex: 1 }}>
              {ended ? preparing(true) : <Text tone="secondary">{previewLine(state.plan, state.circuit)}</Text>}
            </View>
          </View>
          {ended ? null : (
            <StudyPanel
              planId={study.planId}
              filter={study.filter}
              blockId={state.blockId}
              blockMs={state.timer.durationMs}
              remainingMs={left}
              now={now}
              paused={paused}
            />
          )}
        </>
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space[5] }}>
          <View ref={ringRef} collapsable={false} onLayout={measureRing}>
            {dial(size)}
          </View>
          {ended ? (
            preparing(false)
          ) : (
            <Text tone="secondary" align="center">
              {previewLine(state.plan, state.circuit)}
            </Text>
          )}
        </View>
      )}
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
