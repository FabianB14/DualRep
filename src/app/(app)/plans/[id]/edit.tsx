import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import {
  Button,
  hasPlanDraftErrors,
  LoadingView,
  Notice,
  planDraftErrors,
  planDraftFrom,
  planDraftValues,
  PlanForm,
  Screen,
  Section,
  type PlanDraft,
} from '@/components';
import { useMinute, usePlan } from '@/features/study/hooks';
import { deletePlan, updatePlan } from '@/features/study/studyRepo';
import { haptic, useTheme } from '@/theme';

/**
 * Plan settings: rename it, switch between one source and a growing course (progress is kept either
 * way), change the goal or the date, or delete the plan. All saved on the phone, offline too.
 */
export default function EditPlanScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const planId = typeof id === 'string' ? id : null;
  const { user } = useAuth();
  const { space } = useTheme();
  const now = useMinute();
  const { plan, isLoading } = usePlan(planId);
  // null until the first change: the form shows the saved plan (and follows a sync) until then, and
  // after it a sync never overwrites what was typed.
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!plan) {
    if (isLoading) return <LoadingView />;
    return (
      <Screen edges={['bottom', 'left', 'right']}>
        <Notice title="Plan not found" message="It was deleted, or it isn’t on this phone." />
      </Screen>
    );
  }
  if (!plan.isOwner) {
    return (
      <Screen edges={['bottom', 'left', 'right']}>
        <Notice title="Only the owner can change this plan" message="You can still study it and browse its cards." />
      </Screen>
    );
  }
  const current = draft ?? planDraftFrom(plan);
  const errors = planDraftErrors(current);

  const save = async () => {
    if (busy || !planId) return;
    if (hasPlanDraftErrors(errors)) {
      setShowErrors(true);
      haptic('error');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updatePlan(planId, planDraftValues(current));
      haptic('success');
      router.back();
    } catch (problem) {
      setError(`Couldn’t save on this phone: ${String(problem)}`);
      haptic('error');
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!planId || !user) return;
    setBusy(true);
    try {
      const deleted = await deletePlan(planId, user.id);
      if (!deleted) throw new Error('The plan isn’t yours or isn’t on this phone.');
      haptic('success');
      router.dismissTo('/plans');
    } catch (problem) {
      setError(`Couldn’t delete it: ${String(problem instanceof Error ? problem.message : problem)}`);
      haptic('error');
      setBusy(false);
    }
  };

  const confirmDelete = () => {
    Alert.alert(
      'Delete this plan?',
      `“${plan.title}”, its material and its cards are deleted on all your devices. Your past answers stay in your history.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete plan', style: 'destructive', onPress: () => void remove() },
      ],
    );
  };

  return (
    <Screen edges={['bottom', 'left', 'right']} footer={<Button label="Save changes" size="comfortable" loading={busy} onPress={save} />}>
      <PlanForm
        draft={current}
        now={now}
        disabled={busy}
        errors={showErrors ? errors : undefined}
        onChange={(patch) => setDraft({ ...current, ...patch })}
      />
      {error ? <Notice tone="danger" title="Not saved" message={error} /> : null}
      <Section title="Delete">
        <View style={{ gap: space[2] }}>
          <Button label="Delete plan" variant="secondary" disabled={busy} onPress={confirmDelete} />
        </View>
      </Section>
    </Screen>
  );
}
