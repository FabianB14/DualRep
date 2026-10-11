import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView, View } from 'react-native';

import { Button, cardStatusText, Chip, countText, ListRow, Notice, Screen, Text } from '@/components';
import { useMinute, usePlan, usePlanCards, useTopics } from '@/features/study/hooks';
import { citation, type CardSummary } from '@/features/study/studyQueries';
import { useTheme } from '@/theme';

/**
 * A plan's cards, topic by topic (a chip picks one topic), each with when it comes back and the page
 * it came from. Tapping a card opens it. Read from the phone, so it works offline. The plan's owner
 * can add a card of their own to the chosen topic.
 */
export default function CardsScreen() {
  const params = useLocalSearchParams<{ id: string; topic?: string }>();
  const planId = typeof params.id === 'string' ? params.id : null;
  const { colors, space } = useTheme();
  const now = useMinute();
  const { plan } = usePlan(planId);
  const { topics } = useTopics(planId);
  const { cards, isLoading } = usePlanCards(planId);
  const readyTopics = useMemo(() => topics.filter((topic) => topic.status !== 'draft'), [topics]);
  const [topicId, setTopicId] = useState<string | null>(typeof params.topic === 'string' ? params.topic : null);
  const topic = readyTopics.find((entry) => entry.id === topicId) ?? null;
  const topicTitles = useMemo(() => new Map(readyTopics.map((entry) => [entry.id, entry.title])), [readyTopics]);
  const shown = useMemo(() => (topic ? cards.filter((card) => card.topicId === topic.id) : cards), [cards, topic]);

  const subtitle = (card: CardSummary) =>
    [
      cardStatusText(card, now),
      topic ? null : topicTitles.get(card.topicId ?? '') || null,
      card.sourceId === null ? 'Made by hand' : citation(card.page, card.sourceTitle),
    ]
      .filter(Boolean)
      .join(' · ');

  const addTopic = topic ?? readyTopics[0] ?? null;
  const footer =
    plan?.isOwner && addTopic && planId ? (
      <Button
        label="Add a card"
        size="comfortable"
        accessibilityHint={`Adds a card to ${addTopic.title || 'this topic'}`}
        onPress={() => router.push({ pathname: '/plans/[id]/cards/[cardId]', params: { id: planId, cardId: 'new', topic: addTopic.id } })}
      />
    ) : undefined;

  const header = (
    <View style={{ gap: space[3], paddingBottom: space[3] }}>
      {readyTopics.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[2] }} accessibilityLabel="Topics">
          <Chip label="All topics" role="radio" selected={topic === null} onPress={() => setTopicId(null)} />
          {readyTopics.map((entry) => (
            <Chip key={entry.id} label={entry.title || 'Untitled topic'} role="radio" selected={topic?.id === entry.id} onPress={() => setTopicId(entry.id)} />
          ))}
        </ScrollView>
      ) : null}
      <Text variant="caption" tone="secondary" accessibilityLiveRegion="polite">
        {topic ? `${topic.title}: ${countText(shown.length, 'card')}` : countText(shown.length, 'card')}
      </Text>
    </View>
  );

  return (
    <Screen edges={['bottom', 'left', 'right']} scroll={false} footer={footer}>
      <FlatList
        data={shown}
        keyExtractor={(card) => card.id}
        ListHeaderComponent={header}
        ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: colors.border, marginLeft: space[4] }} />}
        renderItem={({ item }) => (
          <View style={{ backgroundColor: colors.surface }}>
            <ListRow
              title={item.question || 'Untitled card'}
              subtitle={subtitle(item)}
              onPress={() => planId && router.push({ pathname: '/plans/[id]/cards/[cardId]', params: { id: planId, cardId: item.id } })}
            />
          </View>
        )}
        ListEmptyComponent={
          isLoading ? (
            <View accessible accessibilityLabel="Loading cards" style={{ paddingVertical: space[8] }}>
              <ActivityIndicator color={colors.mind.solid} />
            </View>
          ) : (
            <Notice
              title={topic ? 'No cards in this topic yet' : 'No cards yet'}
              message="Cards appear here once your material has been read and the outline reviewed."
            />
          )
        }
      />
    </Screen>
  );
}
