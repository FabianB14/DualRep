import { Stack, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { Card, LoadingView, Notice, Screen, sourceKindLabel, StatusPill, Text } from '@/components';
import { parseIso } from '@/features/study/fsrs';
import { useSourceProgress, useSourceText } from '@/features/study/hooks';
import { useTheme } from '@/theme';

/** "12 Oct" in the phone's language. */
function addedOn(iso: string | null): string | null {
  const ms = parseIso(iso);
  return ms === null ? null : new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * Spoken or typed notes as they were added to the plan, to read again. The text comes with the
 * synced source row, so this works offline. Read-only: the cards are made from exactly this text;
 * a corrected version is added as new notes.
 */
export default function NoteScreen() {
  const params = useLocalSearchParams<{ id: string; sourceId: string }>();
  const planId = typeof params.id === 'string' ? params.id : null;
  const sourceId = typeof params.sourceId === 'string' ? params.sourceId : null;
  const { space } = useTheme();
  const { source, isLoading } = useSourceText(sourceId);
  const progress = useSourceProgress(planId);
  const step = progress.sources.find((entry) => entry.sourceId === sourceId) ?? null;

  if (!source) {
    if (isLoading) return <LoadingView />;
    return (
      <Screen edges={['bottom', 'left', 'right']}>
        <Stack.Screen options={{ title: 'Your notes' }} />
        <Notice title="These notes aren’t on this phone" message="They may still be on their way. Go back to the plan and try again in a moment." />
      </Screen>
    );
  }

  const title = source.title || 'Untitled notes';
  const added = addedOn(source.created_at);
  const body = source.body ?? '';

  return (
    <Screen edges={['bottom', 'left', 'right']}>
      <Stack.Screen options={{ title: 'Your notes' }} />
      <View style={{ gap: space[1] }}>
        <Text variant="title">{title}</Text>
        <Text variant="caption" tone="secondary">
          {added ? `${sourceKindLabel(source.kind)} · Added ${added}` : sourceKindLabel(source.kind)}
        </Text>
      </View>
      {step ? <StatusPill tone={step.text.tone} label={step.text.title} accessibilityLabel={`${title}: ${step.text.title}`} /> : null}
      {body ? (
        <Card>
          <Text selectable>{body}</Text>
        </Card>
      ) : (
        <Notice message={source.kind === 'text' ? 'These notes have no text on this phone yet.' : 'Only spoken or typed notes are kept as text to read here.'} />
      )}
      {body ? (
        <Text variant="caption" tone="secondary">
          Cards are made from this text. To change it, add the corrected version as new notes.
        </Text>
      ) : null}
    </Screen>
  );
}
