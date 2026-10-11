import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import {
  Button,
  Chip,
  ConceptMap,
  ListGroup,
  ListRow,
  LoadingView,
  mapNeighbors,
  Notice,
  RELATION_CHOICES,
  Screen,
  Section,
  Text,
  TextField,
} from '@/components';
import { useCardLinks, usePlanCards, usePlanLinks } from '@/features/study/hooks';
import { createCardLink, type LinkRelation } from '@/features/study/studyRepo';
import { newId } from '@/lib/ids';
import { haptic, useTheme } from '@/theme';

/** How many cards the link picker lists at once (search narrows it). */
const PICKER_LIMIT = 40;

/**
 * Links `otherId` to the card in the middle with the relation picked. "Learn this first" means the
 * other card comes first: a prerequisite link from it to the middle card. Every other relation links
 * from the middle card. Resolves to false when the from-card is not on the phone.
 */
function linkToMiddle(centerId: string, otherId: string, relation: LinkRelation, userId: string): Promise<boolean> {
  const first = relation === 'prerequisite';
  return createCardLink({
    id: newId(),
    fromCardId: first ? otherId : centerId,
    toCardId: first ? centerId : otherId,
    createdBy: userId,
    relation,
    createdAt: Date.now(),
  });
}

/**
 * The concept map: one card in the middle, the cards linked to it around it with how they relate.
 * Tapping a card moves it to the middle, so the person walks from idea to idea. Every link is also
 * listed under the map. The one action links another card to the one in the middle. Works offline.
 */
export default function ConceptMapScreen() {
  const params = useLocalSearchParams<{ id: string; card?: string }>();
  const planId = typeof params.id === 'string' ? params.id : null;
  const { user } = useAuth();
  const { space } = useTheme();
  const { cards, isLoading } = usePlanCards(planId);
  const { links: planLinks } = usePlanLinks(planId);
  const [picked, setPicked] = useState<string | null>(typeof params.card === 'string' ? params.card : null);
  const [linking, setLinking] = useState(false);
  const [relation, setRelation] = useState<LinkRelation>('related');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Without a chosen card, start from the best-connected one (else the first).
  const startId = useMemo(() => {
    const degree = new Map<string, number>();
    for (const link of planLinks) {
      degree.set(link.from_card_id, (degree.get(link.from_card_id) ?? 0) + 1);
      degree.set(link.to_card_id, (degree.get(link.to_card_id) ?? 0) + 1);
    }
    let best: string | null = null;
    let most = 0;
    for (const card of cards) {
      const n = degree.get(card.id) ?? 0;
      if (n > most) {
        best = card.id;
        most = n;
      }
    }
    return best ?? cards[0]?.id ?? null;
  }, [cards, planLinks]);
  // A card that is not (or no longer) in the plan's list falls back to the start card.
  const centerId = picked !== null && cards.some((card) => card.id === picked) ? picked : startId;
  const center = cards.find((card) => card.id === centerId) ?? null;
  const { links } = useCardLinks(centerId);
  const neighbors = useMemo(() => (centerId ? mapNeighbors(centerId, links) : []), [centerId, links]);

  const linked = useMemo(() => new Set(neighbors.map((neighbor) => neighbor.cardId)), [neighbors]);
  const candidates = useMemo(() => {
    const words = query.trim().toLowerCase();
    return cards
      .filter((card) => card.id !== centerId && !linked.has(card.id))
      .filter((card) => words === '' || card.question.toLowerCase().includes(words) || card.answer.toLowerCase().includes(words))
      .slice(0, PICKER_LIMIT);
  }, [cards, centerId, linked, query]);

  if (isLoading && cards.length === 0) return <LoadingView />;
  if (!planId || !center || !centerId) {
    return (
      <Screen edges={['bottom', 'left', 'right']}>
        <Notice title="No cards yet" message="The map shows how your cards connect, once your material has been made into cards." />
      </Screen>
    );
  }

  const moveTo = (cardId: string) => {
    setPicked(cardId);
    setLinking(false);
    setError(null);
  };

  const link = async (otherId: string) => {
    if (!user) return;
    setError(null);
    try {
      const created = await linkToMiddle(centerId, otherId, relation, user.id);
      if (!created) throw new Error('The card isn’t on this phone.');
      haptic('success');
      setLinking(false);
      setQuery('');
    } catch (problem) {
      setError(`Couldn’t link them: ${problem instanceof Error ? problem.message : String(problem)}`);
      haptic('error');
    }
  };

  const footer = linking ? (
    <Button label="Cancel" variant="secondary" size="comfortable" onPress={() => setLinking(false)} />
  ) : (
    <Button label="Link another card" size="comfortable" onPress={() => setLinking(true)} disabled={cards.length < 2} />
  );

  return (
    <Screen edges={['bottom', 'left', 'right']} footer={footer}>
      {error ? <Notice tone="danger" title="That didn’t work" message={error} /> : null}

      {linking ? (
        <>
          <Text tone="secondary">
            Link a card to “{center.question}”. First say how it relates, then tap the card.
          </Text>
          <Section title="How does it relate?">
            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: space[2] }}>
              {RELATION_CHOICES.map((choice) => (
                <Chip key={choice.value} label={choice.label} role="radio" selected={relation === choice.value} onPress={() => setRelation(choice.value)} />
              ))}
            </ScrollView>
          </Section>
          <TextField label="Find a card" value={query} onChangeText={setQuery} placeholder="Words from the question or answer" autoCorrect={false} returnKeyType="search" />
          {candidates.length === 0 ? (
            <Notice message={query.trim() ? 'No card matches.' : 'Every card of this plan is already linked to this one.'} />
          ) : (
            <ListGroup>
              {candidates.map((card) => (
                <ListRow
                  key={card.id}
                  title={card.question || 'Untitled card'}
                  accessory="none"
                  accessibilityHint="Links it to the card in the middle"
                  onPress={() => void link(card.id)}
                />
              ))}
            </ListGroup>
          )}
        </>
      ) : (
        <>
          <ConceptMap center={{ cardId: centerId, question: center.question }} neighbors={neighbors} onSelect={moveTo} />
          {neighbors.length === 0 ? <Notice message="This card has no links yet. Link it to another card to see how ideas connect." /> : null}

          {neighbors.length > 0 ? (
            <ListGroup title="Linked cards" description="Tap one to put it in the middle.">
              {neighbors.map((neighbor) => (
                <ListRow
                  key={neighbor.cardId}
                  title={neighbor.question || 'Untitled card'}
                  subtitle={neighbor.relations.join(' · ')}
                  accessibilityHint="Puts this card in the middle"
                  onPress={() => moveTo(neighbor.cardId)}
                />
              ))}
            </ListGroup>
          ) : null}

          <View style={{ gap: space[2] }}>
            <Button
              label="Open the card in the middle"
              variant="secondary"
              onPress={() => router.push({ pathname: '/plans/[id]/cards/[cardId]', params: { id: planId, cardId: centerId } })}
            />
          </View>
        </>
      )}
    </Screen>
  );
}
