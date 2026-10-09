import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import {
  Button,
  Card,
  cardStatusText,
  cardTypeLabel,
  ListGroup,
  ListRow,
  LoadingView,
  Notice,
  relationLabel,
  Screen,
  Section,
  Text,
  TextField,
} from '@/components';
import { useCard, useCardLinks, useMinute, usePlan, useTopics } from '@/features/study/hooks';
import { citation, type CardLinkRow } from '@/features/study/studyQueries';
import { createCard, deleteCard, deleteCardLink, setCardSuspended, STUDY_LIMITS, updateCard } from '@/features/study/studyRepo';
import { newId } from '@/lib/ids';
import { haptic, useTheme } from '@/theme';

type Draft = { question: string; answer: string };

function draftErrors(draft: Draft): { question?: string; answer?: string } {
  const errors: { question?: string; answer?: string } = {};
  if (draft.question.trim() === '') errors.question = 'Write the question.';
  if (draft.answer.trim() === '') errors.answer = 'Write the answer.';
  return errors;
}

/**
 * One card: the question and answer, the page and source it came from, when it comes back, and the
 * cards linked to it. The way on is the concept map with this card in the middle. Its owner can edit
 * or delete it; anyone can pause it (never asked) or link it to another card. With `cardId = new`
 * (and `topic`), the same screen makes a card by hand. All of it works offline.
 */
export default function CardScreen() {
  const params = useLocalSearchParams<{ id: string; cardId: string; topic?: string }>();
  const planId = typeof params.id === 'string' ? params.id : null;
  const isNew = params.cardId === 'new';
  const cardId = !isNew && typeof params.cardId === 'string' ? params.cardId : null;
  const { user } = useAuth();
  const { space } = useTheme();
  const now = useMinute();
  const { plan } = usePlan(planId);
  const { topics } = useTopics(planId);
  const { card, isLoading } = useCard(cardId);
  const { links } = useCardLinks(cardId);
  const [draft, setDraft] = useState<Draft | null>(isNew ? { question: '', answer: '' } : null);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const owner = plan?.isOwner === true;
  const topicId = isNew ? (typeof params.topic === 'string' ? params.topic : null) : (card?.topicId ?? null);
  const topic = topics.find((entry) => entry.id === topicId) ?? null;

  // ---- Editing (a new card, or the owner's edit) -------------------------------------------------
  if (draft) {
    const errors = draftErrors(draft);
    const save = async () => {
      if (busy || !planId) return;
      if (errors.question || errors.answer) {
        setShowErrors(true);
        haptic('error');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        if (isNew) {
          if (!topicId) throw new Error('No topic chosen.');
          const id = newId();
          const created = await createCard({ id, topicId, question: draft.question, answer: draft.answer, createdAt: Date.now() });
          if (!created) throw new Error('The topic isn’t on this phone.');
          haptic('success');
          router.replace({ pathname: '/plans/[id]/cards/[cardId]', params: { id: planId, cardId: id } });
          return;
        }
        if (cardId) await updateCard(cardId, { question: draft.question, answer: draft.answer });
        haptic('success');
        setDraft(null);
        setShowErrors(false);
      } catch (problem) {
        setError(`Couldn’t save on this phone: ${problem instanceof Error ? problem.message : String(problem)}`);
        haptic('error');
      } finally {
        setBusy(false);
      }
    };
    return (
      <Screen
        edges={['bottom', 'left', 'right']}
        footer={
          <>
            <Button label="Save card" size="comfortable" loading={busy} onPress={() => void save()} />
            <Button label="Cancel" variant="ghost" disabled={busy} onPress={() => (isNew ? router.back() : setDraft(null))} />
          </>
        }
      >
        {topic ? <Text tone="secondary">Topic: {topic.title}</Text> : null}
        <TextField
          label="Question"
          value={draft.question}
          onChangeText={(question) => setDraft({ ...draft, question })}
          multiline
          maxLength={STUDY_LIMITS.question}
          autoCapitalize="sentences"
          error={showErrors ? errors.question : null}
        />
        <TextField
          label="Answer"
          value={draft.answer}
          onChangeText={(answer) => setDraft({ ...draft, answer })}
          multiline
          maxLength={STUDY_LIMITS.answer}
          autoCapitalize="sentences"
          hint="Short answers can be typed when studying, if you turn that on in Settings."
          error={showErrors ? errors.answer : null}
        />
        {error ? <Notice tone="danger" title="Not saved" message={error} /> : null}
      </Screen>
    );
  }

  // ---- Viewing -----------------------------------------------------------------------------------
  if (!card || !planId || !cardId) {
    if (isLoading) return <LoadingView />;
    return (
      <Screen edges={['bottom', 'left', 'right']}>
        <Notice title="Card not found" message="It was deleted, or it isn’t on this phone." />
      </Screen>
    );
  }

  const from =
    card.sourceId === null
      ? 'Made by hand'
      : (citation(card.page, card.sourceTitle) ?? (card.page ? `p. ${card.page}, a source you can’t see` : 'A source you can’t see'));

  const togglePause = async () => {
    if (!user || busy) return;
    setBusy(true);
    setError(null);
    try {
      await setCardSuspended(user.id, cardId, !card.suspended);
      haptic('success');
    } catch (problem) {
      setError(`Couldn’t save on this phone: ${String(problem)}`);
      haptic('error');
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = () => {
    Alert.alert('Delete this card?', 'It is deleted on all your devices, with its links.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete card',
        style: 'destructive',
        onPress: () => {
          deleteCard(cardId)
            .then(() => {
              haptic('success');
              router.back();
            })
            .catch((problem: unknown) => setError(`Couldn’t delete it: ${String(problem)}`));
        },
      },
    ]);
  };

  const removeLink = (link: CardLinkRow) => {
    Alert.alert('Remove this link?', link.other_question ?? '', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          deleteCardLink(link.id).catch((problem: unknown) => setError(`Couldn’t remove it: ${String(problem)}`));
        },
      },
    ]);
  };

  return (
    <Screen
      edges={['bottom', 'left', 'right']}
      footer={
        <Button
          label="See it on the concept map"
          size="comfortable"
          onPress={() => router.push({ pathname: '/plans/[id]/map', params: { id: planId, card: cardId } })}
        />
      }
    >
      <View style={{ gap: space[1] }}>
        <Text variant="caption" tone="secondary">
          {[cardTypeLabel(card.cardType), topic?.title].filter(Boolean).join(' · ')}
        </Text>
        <Text variant="title">{card.question || 'Untitled card'}</Text>
      </View>

      <Card>
        <Text variant="label" tone="secondary">
          Answer
        </Text>
        <Text variant="bodyLarge">{card.answer}</Text>
        <Text variant="caption" tone="secondary">
          {from}
        </Text>
      </Card>

      <Text tone="secondary" accessibilityLiveRegion="polite">
        {card.suspended ? 'Paused: it isn’t asked in your focus blocks.' : cardStatusText(card, now)}
      </Text>

      {error ? <Notice tone="danger" title="That didn’t work" message={error} /> : null}

      <Section title="Linked cards">
        {links.length === 0 ? (
          <Notice message="No links yet. Open the concept map to link this card to another one." />
        ) : (
          <ListGroup>
            {links.map((link) => (
              <ListRow
                key={link.id}
                title={link.other_question || 'A card you can’t see'}
                subtitle={relationLabel(link.relation, link.from_card_id === cardId)}
                onPress={() => router.push({ pathname: '/plans/[id]/cards/[cardId]', params: { id: planId, cardId: link.other_card_id } })}
                trailing={
                  link.created_by === user?.id ? (
                    <Button
                      label="Remove"
                      variant="ghost"
                      fullWidth={false}
                      accessibilityLabel={`Remove the link to ${link.other_question ?? 'this card'}`}
                      onPress={() => removeLink(link)}
                    />
                  ) : undefined
                }
              />
            ))}
          </ListGroup>
        )}
      </Section>

      <Section title="This card">
        <View style={{ gap: space[2] }}>
          {owner ? (
            <Button label="Edit card" variant="secondary" disabled={busy} onPress={() => setDraft({ question: card.question, answer: card.answer })} />
          ) : null}
          <Button
            label={card.suspended ? 'Ask me this card again' : 'Pause this card'}
            variant="secondary"
            loading={busy}
            accessibilityHint={card.suspended ? 'It comes back in your focus blocks' : 'It isn’t asked until you bring it back'}
            onPress={() => void togglePause()}
          />
          {owner ? <Button label="Delete card" variant="ghost" disabled={busy} onPress={confirmDelete} /> : null}
        </View>
      </Section>
    </Screen>
  );
}
