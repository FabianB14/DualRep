import { router } from 'expo-router';
import { useState } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import {
  Button,
  EMPTY_PLAN_DRAFT,
  hasPlanDraftErrors,
  Notice,
  planDraftErrors,
  planDraftValues,
  PlanForm,
  Screen,
  type PlanDraft,
} from '@/components';
import { useMinute } from '@/features/study/hooks';
import { createPlan } from '@/features/study/studyRepo';
import { newId } from '@/lib/ids';
import { haptic } from '@/theme';

/**
 * A new study plan. Saved on the phone at once (offline is fine); the plan's screen then offers
 * adding the first material, which is the step that needs the internet.
 */
export default function NewPlanScreen() {
  const { user } = useAuth();
  const now = useMinute();
  const [draft, setDraft] = useState<PlanDraft>(EMPTY_PLAN_DRAFT);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = planDraftErrors(draft);

  const save = async () => {
    if (!user || busy) return;
    if (hasPlanDraftErrors(errors)) {
      setShowErrors(true);
      haptic('error');
      return;
    }
    setBusy(true);
    setError(null);
    const id = newId();
    try {
      await createPlan({ id, ownerId: user.id, ...planDraftValues(draft), createdAt: Date.now() });
      haptic('success');
      router.replace({ pathname: '/plans/[id]', params: { id } });
    } catch (problem) {
      setError(`Couldn’t save on this phone: ${String(problem)}`);
      haptic('error');
      setBusy(false);
    }
  };

  return (
    <Screen
      edges={['bottom', 'left', 'right']}
      footer={<Button label="Create plan" size="comfortable" loading={busy} onPress={save} />}
    >
      <PlanForm
        draft={draft}
        now={now}
        disabled={busy}
        errors={showErrors ? errors : undefined}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      />
      {error ? <Notice tone="danger" title="Not saved" message={error} /> : null}
    </Screen>
  );
}
