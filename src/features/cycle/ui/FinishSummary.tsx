import { useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';

import { Button, Screen, StatCard, Text } from '@/components';

import type { CycleSummary } from '../cycleMachine';
import { summarySentence, summaryStats, summaryTitle } from './cycleText';
import { TopBar } from './TopBar';

export type FinishSummaryProps = {
  summary: CycleSummary;
  /** Clears the summary (the cycle screen then shows the start panel). */
  onDismiss(): void;
  /** Leaves for Home. */
  onLeave(): void;
};

/**
 * The end of a cycle: what was done (blocks, focus minutes, sets), then back to Home. The summary is
 * shown once: every way out clears it, Android's back button and gesture included, so the next
 * "Start a study block" on Home opens the start panel instead of this old summary.
 */
export function FinishSummary({ summary, onDismiss, onLeave }: FinishSummaryProps) {
  const stats = summaryStats(summary);
  const leave = () => {
    onDismiss();
    onLeave();
  };
  const leaveRef = useRef(leave);
  useEffect(() => {
    leaveRef.current = leave;
  });
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      leaveRef.current();
      return true;
    });
    return () => subscription.remove();
  }, []);

  return (
    <Screen
      footer={
        <>
          <Button label="Back to Today" size="comfortable" onPress={leave} />
          <Button
            label={summary.mode === 'move_only' ? 'Train again' : 'Start another cycle'}
            variant="secondary"
            onPress={onDismiss}
          />
        </>
      }
    >
      <TopBar title="Summary" onClose={leave} />
      <Text variant="headline" accessibilityLiveRegion="polite">
        {summaryTitle(summary)}
      </Text>
      <StatCard stats={stats} accessibilityLabel={summarySentence(summary)} />
      <Text tone="secondary">Everything is saved on this phone and syncs when you are online.</Text>
    </Screen>
  );
}
