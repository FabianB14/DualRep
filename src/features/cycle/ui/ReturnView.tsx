import { View, useWindowDimensions } from 'react-native';

import { Button, Notice, Screen, Text } from '@/components';
import { formatClock, progress, remainingMs } from '@/features/timer/timerMath';
import { useTheme } from '@/theme';

import type { ReturnState } from '../cycleMachine';
import { BlockRating } from './BlockRating';
import { runningTotals } from './cycleText';
import { FocusDial, focusRingSize } from './FocusDial';
import { TopBar } from './TopBar';

export type ReturnViewProps = {
  state: ReturnState;
  now: number;
  error: string | null;
  onStartNow(): void;
  onFinish(): void;
  onRate(effort: number): void;
};

/**
 * The return: the last rest rolls into the next focus block. A short countdown runs, and when it
 * reaches zero the next block starts on its own (zero taps). "Start now" skips the wait; "Finish for
 * now" ends the cycle with a summary.
 */
export function ReturnView({ state, now, error, onStartNow, onFinish, onRate }: ReturnViewProps) {
  const { space } = useTheme();
  const { width } = useWindowDimensions();
  const left = remainingMs(state.countdown, now);
  const clock = formatClock(left);
  const size = Math.round(focusRingSize(width) * 0.7);

  return (
    <Screen
      footer={
        <>
          <Button label="Start now" size="comfortable" accessibilityHint="Starts the next focus block" onPress={onStartNow} />
          <Button label="Finish for now" variant="secondary" accessibilityHint="Ends the cycle and shows a summary" onPress={onFinish} />
        </>
      }
    >
      <TopBar running title="Back to studying" subtitle={`Focus block ${state.blockNumber + 1} is next`} />
      {error ? <Notice tone="warning" message={error} /> : null}
      <View style={{ alignItems: 'center', gap: space[4] }}>
        <Text variant="title" align="center" accessibilityLabel={`Next focus block in ${clock}. It starts on its own.`}>
          Next focus block in {clock}
        </Text>
        <FocusDial
          size={size}
          progress={1 - progress(state.countdown, now)}
          clock={clock}
          caption="to go"
          decorative
        />
        <Text tone="secondary" align="center">
          So far: {runningTotals(state.stats)}
        </Text>
      </View>
      {state.blockId !== null ? <BlockRating value={state.effortRating} onRate={onRate} /> : null}
    </Screen>
  );
}
