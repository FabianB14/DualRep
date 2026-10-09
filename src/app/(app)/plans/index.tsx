import { router } from 'expo-router';
import { useMemo } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Button, ListGroup, ListRow, Notice, planCountsText, Screen, targetDateText, Text } from '@/components';
import { useMinute, usePlans } from '@/features/study/hooks';
import { useTheme } from '@/theme';

/**
 * Study plans: every plan on this phone (the user's own and, later, a group's), newest change first,
 * each with what is due. Read from the phone, so it works offline. The one action: a new plan.
 */
export default function PlansScreen() {
  const { colors, space } = useTheme();
  const { plans, isLoading } = usePlans();
  const now = useMinute();
  const dueTotal = useMemo(() => plans.reduce((sum, plan) => sum + plan.dueCount, 0), [plans]);

  return (
    <Screen
      edges={['bottom', 'left', 'right']}
      footer={<Button label="New plan" size="comfortable" onPress={() => router.push('/plans/new')} />}
    >
      {isLoading && plans.length === 0 ? (
        <View accessible accessibilityLabel="Loading your plans" style={{ paddingVertical: space[8] }}>
          <ActivityIndicator color={colors.mind.solid} />
        </View>
      ) : plans.length === 0 ? (
        <Notice
          title="No plans yet"
          message="A plan holds one course or exam. Add your PDFs, Word files, photos of notes or web pages to it, and DualRep turns them into cards to review in your focus blocks."
        />
      ) : (
        <>
          <Text tone="secondary" accessibilityLiveRegion="polite">
            {dueTotal > 0 ? `${dueTotal} ${dueTotal === 1 ? 'card is' : 'cards are'} due across your plans.` : 'Nothing is due right now.'}
          </Text>
          <ListGroup>
            {plans.map((plan) => (
              <ListRow
                key={plan.id}
                title={plan.title || 'Untitled plan'}
                subtitle={[planCountsText(plan), plan.targetDate ? targetDateText(plan.targetDate, now) : null].filter(Boolean).join('\n')}
                badge={plan.isOwner ? undefined : 'Group'}
                onPress={() => router.push({ pathname: '/plans/[id]', params: { id: plan.id } })}
              />
            ))}
          </ListGroup>
        </>
      )}
    </Screen>
  );
}
