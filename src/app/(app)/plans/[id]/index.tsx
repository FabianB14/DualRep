import { useStatus } from '@powersync/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import {
  Button,
  Card,
  countText,
  ListGroup,
  ListRow,
  LoadingView,
  Notice,
  OfflineNotice,
  SCOPE_TEXT,
  Screen,
  Section,
  sourceKindLabel,
  StatCard,
  StatusPill,
  targetDateText,
  Text,
} from '@/components';
import { useMinute, usePlan, useSourceProgress, useTopics, type SourceView } from '@/features/study/hooks';
import type { PlanNextStep } from '@/features/study/sourceProgress';
import { cancelJob, retryJob, studyErrorMessage } from '@/features/study/studyApi';
import { readStudyDefaults, saveStudyDefaults } from '@/features/study/studyPrefs';
import { supabase } from '@/lib/supabase';
import { haptic, useTheme } from '@/theme';

type JobAction = { jobId: string; kind: 'retry' | 'skip' };
/** A failed step retried or skipped here, and which failure of that job it was (its updated_at). */
type Handled = { kind: JobAction['kind']; version: string | null };

/**
 * One plan: what is due, its material with where each piece is in the pipeline (from synced rows,
 * so the status moves on by itself), its topics, and the one next step as the primary action:
 * check a transcription, review the outline, try a failed step again, study, or add material.
 * Everything shown works offline; trying a step again needs the internet.
 */
export default function PlanScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const planId = typeof id === 'string' ? id : null;
  const { space } = useTheme();
  const now = useMinute();
  const status = useStatus();
  const online = status.connected || status.connecting;
  const { plan, isLoading: planLoading } = usePlan(planId);
  const progress = useSourceProgress(planId);
  const { topics } = useTopics(planId);
  const [busy, setBusy] = useState<JobAction | null>(null);
  // Failed steps retried or skipped on this screen: their rows still say "failed" until the next sync.
  // Keyed by job and failure: Try again reuses the job, so when it fails again (a newer updated_at)
  // that new failure shows, with Try again, instead of "Trying again" for as long as the screen is open.
  const [handled, setHandled] = useState<ReadonlyMap<string, Handled>>(new Map());
  const [error, setError] = useState<string | null>(null);

  if (!plan || !planId) {
    if (planLoading) return <LoadingView />;
    return (
      <Screen edges={['bottom', 'left', 'right']}>
        <Notice title="Plan not found" message="It was deleted, or it isn’t on this phone." />
        <Button label="All plans" variant="secondary" onPress={() => router.dismissTo('/plans')} />
      </Screen>
    );
  }

  const owner = plan.isOwner;
  const readyTopics = topics.filter((topic) => topic.status !== 'draft');
  /** What was done here about this source's failed step, while that same failure is still shown. */
  const handledFor = (source: SourceView | undefined): JobAction['kind'] | null => {
    const jobId = source?.step.step === 'failed' ? source.step.jobId : null;
    const entry = jobId ? handled.get(jobId) : undefined;
    return entry && entry.version === source?.stepJobVersion ? entry.kind : null;
  };

  const runJob = async (action: JobAction) => {
    if (busy) return;
    setBusy(action);
    setError(null);
    // The failure acted on (read before the call: a sync may land while it runs).
    const version = progress.sources.find((s) => s.step.step === 'failed' && s.step.jobId === action.jobId)?.stepJobVersion ?? null;
    try {
      if (action.kind === 'retry') await retryJob(supabase, action.jobId);
      else await cancelJob(supabase, action.jobId);
      setHandled((current) => new Map(current).set(action.jobId, { kind: action.kind, version }));
      haptic('success');
    } catch (problem) {
      setError(studyErrorMessage(problem));
      haptic('error');
    } finally {
      setBusy(null);
    }
  };

  const studyNow = async () => {
    // The cycle's start panel starts with the last plan chosen on this phone (study-defaults), so
    // making this plan that choice opens the panel with it picked (the filter stays as it was).
    const defaults = await readStudyDefaults();
    await saveStudyDefaults({ planId, filter: defaults.filter }).catch(() => undefined);
    router.push('/cycle');
  };

  const addMaterial = () => router.push({ pathname: '/plans/[id]/add', params: { id: planId } });
  const openStep = (step: PlanNextStep) => {
    if (step.kind === 'check_transcripts') router.push({ pathname: '/plans/[id]/check/[sourceId]', params: { id: planId, sourceId: step.sourceId } });
    else if (step.kind === 'review_outline') router.push({ pathname: '/plans/[id]/outline', params: { id: planId } });
  };

  const footer = (() => {
    const next = progress.nextStep;
    if (progress.isLoading) return null;
    if (next.kind === 'study') return <Button label="Study now" size="comfortable" onPress={() => void studyNow()} />;
    if (!owner) {
      return (
        <Text tone="secondary" align="center" accessibilityLiveRegion="polite">
          The plan’s owner is still adding its material.
        </Text>
      );
    }
    switch (next.kind) {
      case 'check_transcripts':
        return <Button label="Check the transcription" size="comfortable" onPress={() => openStep(next)} />;
      case 'review_outline':
        return <Button label="Review the outline" size="comfortable" onPress={() => openStep(next)} />;
      case 'retry':
        if (!next.jobId || handledFor(progress.sources.find((s) => s.sourceId === next.sourceId)) !== null) break;
        return (
          <Button
            label="Try again"
            size="comfortable"
            loading={busy?.jobId === next.jobId && busy.kind === 'retry'}
            accessibilityHint={next.message}
            onPress={() => void runJob({ jobId: next.jobId as string, kind: 'retry' })}
          />
        );
      case 'add_material':
        return <Button label="Add material" size="comfortable" onPress={addMaterial} />;
      case 'working':
        break;
    }
    return (
      <Text tone="secondary" align="center" accessibilityLiveRegion="polite">
        Getting your material ready. It carries on while you do something else.
      </Text>
    );
  })();

  const details = [SCOPE_TEXT[plan.scope].label, plan.targetDate ? `Exam ${targetDateText(plan.targetDate, now)}` : null].filter(Boolean).join(' · ');

  return (
    <Screen edges={['bottom', 'left', 'right']} footer={footer}>
      <View style={{ gap: space[1] }}>
        <Text variant="headline">{plan.title || 'Untitled plan'}</Text>
        <Text tone="secondary">{details}</Text>
        {plan.goal ? <Text>{plan.goal}</Text> : null}
      </View>

      <StatCard
        stats={[
          { value: plan.dueCount, label: 'due today' },
          { value: plan.newCount, label: 'new' },
          { value: plan.cardCount, label: plan.cardCount === 1 ? 'card' : 'cards' },
        ]}
      />

      {plan.cardCount > 0 && progress.nextStep.kind !== 'study' ? (
        <Button label="Study now" variant="secondary" accessibilityHint="Studies the cards made so far" onPress={() => void studyNow()} />
      ) : null}

      {error ? <Notice tone="danger" title="That didn’t work" message={error} accessibilityLiveRegion="polite" /> : null}
      {!online && owner && progress.nextStep.kind === 'retry' ? <OfflineNotice action="Trying a step again" /> : null}

      <Section title="Material" description={owner ? undefined : 'Added by the plan’s owner.'}>
        {progress.sources.length === 0 && !progress.isLoading ? (
          <Notice message={owner ? 'Nothing here yet. Add a PDF, a Word file, photos of your notes or a web page.' : 'Nothing here yet.'} />
        ) : null}
        {progress.sources.map((source) => (
          <SourceCard
            key={source.planSourceId}
            source={source}
            owner={owner}
            inFooter={'sourceId' in progress.nextStep && progress.nextStep.sourceId === source.sourceId}
            busy={busy}
            handled={handledFor(source)}
            onCheck={() => router.push({ pathname: '/plans/[id]/check/[sourceId]', params: { id: planId, sourceId: source.sourceId } })}
            onReview={() => router.push({ pathname: '/plans/[id]/outline', params: { id: planId } })}
            onJob={(action) => void runJob(action)}
          />
        ))}
        {owner && progress.nextStep.kind !== 'add_material' ? (
          <Button label="Add material" variant="secondary" onPress={addMaterial} accessibilityHint="Needs the internet" />
        ) : null}
      </Section>

      <Section title="Topics">
        {readyTopics.length === 0 ? (
          <Notice message="Topics appear here once your material has been read and the outline reviewed." />
        ) : (
          <ListGroup>
            {readyTopics.map((topic) => (
              <ListRow
                key={topic.id}
                title={topic.title || 'Untitled topic'}
                value={topic.status === 'confirmed' && topic.cardCount === 0 ? 'Making cards' : countText(topic.cardCount, 'card')}
                onPress={() => router.push({ pathname: '/plans/[id]/cards', params: { id: planId, topic: topic.id } })}
              />
            ))}
          </ListGroup>
        )}
      </Section>

      <ListGroup title="More">
        <ListRow
          title="All cards"
          subtitle="Browse by topic"
          value={countText(plan.cardCount, 'card')}
          onPress={() => router.push({ pathname: '/plans/[id]/cards', params: { id: planId } })}
        />
        <ListRow
          title="Concept map"
          subtitle="How your cards connect"
          onPress={() => router.push({ pathname: '/plans/[id]/map', params: { id: planId } })}
        />
        {owner ? (
          <ListRow
            title="Plan settings"
            subtitle="Name, kind, goal, date, delete"
            onPress={() => router.push({ pathname: '/plans/[id]/edit', params: { id: planId } })}
          />
        ) : null}
      </ListGroup>
    </Screen>
  );
}

/** One piece of material: its name and kind, where it is in the pipeline, and what it needs now. */
function SourceCard({
  source,
  owner,
  inFooter,
  busy,
  handled,
  onCheck,
  onReview,
  onJob,
}: {
  source: SourceView;
  owner: boolean;
  /** Its step is the screen's primary action (the footer button), so the card doesn't repeat it. */
  inFooter: boolean;
  busy: JobAction | null;
  /** Its failed step was just retried or skipped here (the synced row hasn't caught up yet), else null. */
  handled: JobAction['kind'] | null;
  onCheck(): void;
  onReview(): void;
  onJob(action: JobAction): void;
}) {
  const { space } = useTheme();
  const { step, text } = source;
  const title = source.status === null ? 'A source you can’t see' : source.title || 'Untitled';
  const jobId = step.step === 'failed' ? step.jobId : null;
  const waitingForRetry = jobId !== null && handled !== null;
  const statusLabel = !waitingForRetry ? text.title : handled === 'skip' ? 'Page skipped' : 'Trying again';
  const detail = !waitingForRetry ? text.detail : handled === 'skip' ? 'Carrying on with the other pages.' : 'Back in the queue.';
  const kind = sourceKindLabel(source.kind);
  const offers = owner && !waitingForRetry && !inFooter;

  return (
    <Card>
      <View style={{ gap: space[1] }}>
        <Text variant="label">{title}</Text>
        <Text variant="caption" tone="secondary">
          {source.cardCount > 0 ? `${kind} · ${countText(source.cardCount, 'card')}` : kind}
        </Text>
      </View>
      <View style={{ gap: space[1] }} accessibilityLiveRegion="polite">
        <StatusPill tone={waitingForRetry ? 'info' : text.tone} label={statusLabel} accessibilityLabel={`${title}: ${statusLabel}`} />
        {detail ? <Text tone="secondary">{detail}</Text> : null}
        {source.note ? (
          <Text variant="caption" tone="secondary">
            {source.note}
          </Text>
        ) : null}
      </View>
      {offers && text.action === 'check_transcripts' ? (
        <Button label="Check the transcription" variant="secondary" onPress={onCheck} />
      ) : null}
      {offers && text.action === 'review_outline' ? (
        <Button label="Review the outline" variant="secondary" onPress={onReview} />
      ) : null}
      {owner && !waitingForRetry && text.action === 'retry' && jobId ? (
        <View style={{ gap: space[2] }}>
          {inFooter ? null : (
            <Button
              label="Try again"
              variant="secondary"
              loading={busy?.jobId === jobId && busy.kind === 'retry'}
              disabled={busy !== null}
              accessibilityHint="Needs the internet"
              onPress={() => onJob({ jobId, kind: 'retry' })}
            />
          )}
          {step.step === 'failed' && step.canSkip ? (
            <Button
              label="Skip this page"
              variant="ghost"
              loading={busy?.jobId === jobId && busy.kind === 'skip'}
              disabled={busy !== null}
              accessibilityHint="Leaves this page out and carries on with the others"
              onPress={() => onJob({ jobId, kind: 'skip' })}
            />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}
