import { router, type Href } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { Button, ListGroup, ListRow, Screen, StatCard, Text } from '@/components';
import { CYCLE_STATE_KEY, parseCycleState, type CyclePhase } from '@/features/cycle/cycleMachine';
import { useLocalState } from '@/features/cycle/localState';
import { useTodaySummary } from '@/features/history/useHistory';
import { formatMinutes } from '@/features/settings/profile';
import { useTrainingDefaults } from '@/features/settings/useTrainingDefaults';
import { useDueCount, usePlans } from '@/features/study/hooks';
import { useTheme } from '@/theme';

/** What the primary button says while a cycle is running, by phase. */
const CONTINUE_LABEL: Record<Exclude<CyclePhase, 'idle'>, string> = {
  focus: 'Back to your focus block',
  move: 'Back to your workout',
  return: 'Back to your cycle',
};

/** The other screens, in the order they are listed under "More". */
const LINKS: readonly { title: string; subtitle: string; href: Href }[] = [
  { title: 'Setups', subtitle: 'Where you train and the gear you have', href: '/setups' },
  { title: 'Presets', subtitle: 'How each workout is split across the body', href: '/presets' },
  { title: 'Exercise library', subtitle: 'Browse exercises or add your own', href: '/library' },
  { title: 'History', subtitle: 'Your focus blocks and workouts', href: '/history' },
  { title: 'Settings', subtitle: 'Block length, units, notifications, sign out', href: '/settings' },
  { title: 'Sync check', subtitle: 'Prove offline changes reach the server', href: '/sync-check' },
  { title: 'Timer check', subtitle: 'Measure how late the end-of-block alert rings', href: '/timer-check' },
];

/** The line under "Study plans": what is due, or what a plan is for when there is none yet. */
function studySubtitle(due: number, plans: number): string {
  if (plans === 0) return 'Turn your course material into cards';
  if (due === 0) return 'Nothing due today';
  return `${due} ${due === 1 ? 'card' : 'cards'} due today`;
}

/**
 * Home ("Today"): the one thing to do next — start a study block — with "Just train" beside it, the
 * study plans with the cards due, the defaults the next cycle will use (each opens the screen that
 * changes it), today's numbers, and the other screens. Everything is read from the phone, so it works
 * offline and before the first sync.
 */
export default function HomeScreen() {
  const { user } = useAuth();
  const { space } = useTheme();
  const defaults = useTrainingDefaults();
  const today = useTodaySummary();
  const due = useDueCount();
  const { plans } = usePlans();
  const { value: savedCycle } = useLocalState<unknown>(CYCLE_STATE_KEY);
  const phase = useMemo(() => parseCycleState(savedCycle, user?.id ?? null).phase, [savedCycle, user?.id]);
  const running = phase !== 'idle';
  const dateLabel = useMemo(
    () => new Date(today.since).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
    [today.since],
  );

  const footer = running ? (
    <Button label={CONTINUE_LABEL[phase]} size="comfortable" onPress={() => router.push('/cycle')} />
  ) : (
    <>
      <Button label="Start a study block" size="comfortable" onPress={() => router.push('/cycle')} />
      <Button
        label="Just train"
        variant="secondary"
        accent="body"
        accessibilityHint="Starts a workout without a focus block"
        onPress={() => router.push({ pathname: '/cycle', params: { mode: 'move' } })}
      />
    </>
  );

  const summaryText = `${today.blocks} focus ${today.blocks === 1 ? 'block' : 'blocks'}, ${today.focusMinutes} focus minutes, ${today.sets} ${today.sets === 1 ? 'set' : 'sets'} today`;

  return (
    <Screen footer={footer}>
      <View style={{ gap: space[1], marginTop: space[4] }}>
        <Text variant="caption" tone="mind" style={{ fontWeight: '600' }}>
          DualRep
        </Text>
        <Text variant="headline">Today</Text>
        <Text tone="secondary">{dateLabel}</Text>
      </View>

      <StatCard
        accessibilityLabel={summaryText}
        stats={[
          { value: today.blocks, label: today.blocks === 1 ? 'focus block' : 'focus blocks' },
          { value: today.focusMinutes, label: 'focus minutes' },
          { value: today.sets, label: today.sets === 1 ? 'set' : 'sets' },
        ]}
      />

      <ListGroup title="Study">
        <ListRow
          title="Study plans"
          subtitle={studySubtitle(due.count, plans.length)}
          value={due.count > 0 ? `${due.count} due` : undefined}
          accessibilityLabel={`Study plans, ${studySubtitle(due.count, plans.length)}`}
          onPress={() => router.push('/plans')}
        />
      </ListGroup>

      <ListGroup title="Next cycle" description="Tap one to change it.">
        <ListRow
          title="Block length"
          value={formatMinutes(defaults.blockMinutes)}
          accessibilityHint="Opens settings"
          onPress={() => router.push('/settings')}
        />
        <ListRow
          title="Preset"
          value={defaults.preset.name}
          accessibilityHint="Opens presets"
          onPress={() => router.push('/presets')}
        />
        <ListRow
          title="Setup"
          value={defaults.setup ? defaults.setup.name : 'None yet'}
          subtitle={defaults.setup ? undefined : 'Add where you train and what gear you have'}
          accessibilityHint="Opens setups"
          onPress={() => router.push('/setups')}
        />
      </ListGroup>

      <ListGroup title="More">
        {LINKS.map((link) => (
          <ListRow key={link.title} title={link.title} subtitle={link.subtitle} onPress={() => router.push(link.href)} />
        ))}
      </ListGroup>
    </Screen>
  );
}
