import { useStatus } from '@powersync/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, View } from 'react-native';

import {
  Button,
  Card,
  countText,
  ListGroup,
  ListRow,
  LoadingView,
  moveOutlineItem,
  Notice,
  OfflineNotice,
  OUTLINE_TITLE_MAX,
  outlineDecisions,
  outlineErrors,
  outlineItemsFrom,
  outlineSummary,
  renameOutlineItem,
  ReorderButtons,
  reorderActions,
  Screen,
  SegmentedControl,
  setOutlineKeep,
  Text,
  TextField,
  type OutlineItem,
} from '@/components';
import { usePlan, useTopics } from '@/features/study/hooks';
import { approveOutline, studyErrorMessage } from '@/features/study/studyApi';
import { supabase } from '@/lib/supabase';
import { haptic, useTheme } from '@/theme';

type KeepChoice = 'keep' | 'cut';

/**
 * Review the outline proposed for new material: keep or cut each topic, rename it, put the topics in
 * order with Move up / Move down (buttons and screen-reader actions; nothing needs dragging). Changes
 * stay on this screen until "Save and make cards", which sends them in one go and starts making cards
 * for the topics kept (that step needs the internet).
 */
export default function OutlineReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const planId = typeof id === 'string' ? id : null;
  const { space } = useTheme();
  const status = useStatus();
  const online = status.connected || status.connecting;
  const { plan } = usePlan(planId);
  const { topics, isLoading } = useTopics(planId);
  const drafts = useMemo(() => topics.filter((topic) => topic.status === 'draft'), [topics]);
  const existing = useMemo(() => topics.filter((topic) => topic.status !== 'draft'), [topics]);
  // The person's working copy; merged with the drafts on each render, so new drafts (a second outline
  // synced in) join it without undoing edits.
  const [edits, setEdits] = useState<OutlineItem[]>([]);
  const items = useMemo(() => outlineItemsFrom(drafts, edits), [drafts, edits]);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isLoading && topics.length === 0) return <LoadingView />;
  if (plan && !plan.isOwner) {
    return (
      <Screen edges={['bottom', 'left', 'right']}>
        <Notice title="Only the plan’s owner can review the outline" message="You can study the topics once their cards are made." />
      </Screen>
    );
  }
  if (drafts.length === 0) {
    return (
      <Screen edges={['bottom', 'left', 'right']}>
        <Notice
          title="No outline to review"
          message="A new outline shows here once your material has been read. If you just saved one, its cards are being made."
        />
      </Screen>
    );
  }

  const errors = outlineErrors(items);
  const keptCount = items.filter((item) => item.keep).length;

  const send = async () => {
    if (!planId) return;
    setBusy(true);
    setError(null);
    try {
      await approveOutline(supabase, { plan_id: planId, source_id: null, topics: outlineDecisions(items) });
      haptic('success');
      router.back();
    } catch (problem) {
      setError(studyErrorMessage(problem));
      haptic('error');
      setBusy(false);
    }
  };

  const save = () => {
    if (busy) return;
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      haptic('error');
      return;
    }
    if (keptCount === 0) {
      Alert.alert('Cut every topic?', 'No cards will be made from this material.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Cut them all', style: 'destructive', onPress: () => void send() },
      ]);
      return;
    }
    void send();
  };

  const move = (index: number, delta: -1 | 1) => setEdits(moveOutlineItem(items, index, delta));

  const footer = (
    <>
      <Text tone="secondary" align="center" accessibilityLiveRegion="polite">
        {outlineSummary(items)}
      </Text>
      <Button
        label="Save and make cards"
        size="comfortable"
        loading={busy}
        accessibilityHint="Needs the internet"
        onPress={save}
      />
    </>
  );

  return (
    <Screen edges={['bottom', 'left', 'right']} footer={footer}>
      <Text tone="secondary">
        Keep the topics you need to learn, cut the rest, and put them in the order you want to study them. Cards are made only
        for the topics you keep.
      </Text>
      {!online ? <OfflineNotice action="Saving the outline" /> : null}
      {error ? <Notice tone="danger" title="Not saved" message={error} accessibilityLiveRegion="polite" /> : null}

      {existing.length > 0 ? (
        <ListGroup title="Already in this plan" description="New topics are added after these.">
          {existing.map((topic) => (
            <ListRow key={topic.id} title={topic.title || 'Untitled topic'} value={countText(topic.cardCount, 'card')} />
          ))}
        </ListGroup>
      ) : null}

      <View style={{ gap: space[3] }}>
        <Text variant="subtitle" accessibilityRole="header">
          New topics
        </Text>
        {items.map((item, index) => {
          const name = item.title.trim() || item.proposed || `Topic ${index + 1}`;
          const choice: KeepChoice = item.keep ? 'keep' : 'cut';
          return (
            <Card key={item.id} style={{ opacity: item.keep ? 1 : 0.75 }}>
              <View
                accessible
                accessibilityLabel={`Topic ${index + 1} of ${items.length}: ${name}, ${item.keep ? 'kept' : 'cut'}`}
                accessibilityActions={[
                  ...reorderActions(index, items.length),
                  { name: 'toggle', label: item.keep ? 'Cut' : 'Keep' },
                ]}
                onAccessibilityAction={(event) => {
                  const action = event.nativeEvent.actionName;
                  if (action === 'moveUp') move(index, -1);
                  else if (action === 'moveDown') move(index, 1);
                  else if (action === 'toggle') setEdits(setOutlineKeep(items, item.id, !item.keep));
                }}
              >
                <Text variant="caption" tone="secondary">
                  Topic {index + 1} of {items.length}
                </Text>
              </View>
              <SegmentedControl<KeepChoice>
                value={choice}
                disabled={busy}
                options={[
                  { value: 'keep', label: 'Keep', accessibilityLabel: `Keep ${name}` },
                  { value: 'cut', label: 'Cut', accessibilityLabel: `Cut ${name}` },
                ]}
                onChange={(value) => setEdits(setOutlineKeep(items, item.id, value === 'keep'))}
              />
              <TextField
                label="Name"
                accessibilityLabel={`Name of topic ${index + 1}`}
                value={item.title}
                onChangeText={(title) => setEdits(renameOutlineItem(items, item.id, title))}
                editable={item.keep && !busy}
                maxLength={OUTLINE_TITLE_MAX}
                error={showErrors ? errors[item.id] : null}
                hint={item.title.trim() !== item.proposed.trim() ? `Suggested: ${item.proposed}` : undefined}
              />
              <ReorderButtons itemLabel={name} index={index} count={items.length} disabled={busy} onMove={(delta) => move(index, delta)} />
            </Card>
          );
        })}
      </View>
    </Screen>
  );
}
