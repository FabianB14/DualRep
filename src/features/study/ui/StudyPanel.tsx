import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { Button, Card, Notice, Text, TextField } from '@/components';
import { newId } from '@/lib/ids';
import { haptic, useTheme } from '@/theme';

import { previewDue, RATING, schedulerFor, type StudyGrade } from '../fsrs';
import { useFsrsParams, usePlan, useSourceProgress, useStudyQueue } from '../hooks';
import { checkTypedAnswer } from '../matcher';
import type { StudyFilter } from '../queue';
import { citation } from '../studyQueries';
import { answerCard } from '../studyRepo';
import { answerModeFor, ratingButtons, useStudyPrefs } from '../studyPrefs';
import {
  answerVisible,
  countsLine,
  doneMessage,
  feedbackLine,
  gradeWord,
  markWrong,
  notReadyLine,
  openCard,
  quizMe,
  ratingHint,
  reasonLabel,
  reasonNote,
  reveal,
  SAVE_PROBLEM,
  waitLine,
  type AnswerOutcome,
  type OpenCard,
} from './studyPanelModel';

export type StudyPanelProps = {
  /** The cycle's study plan (study_plans.id) and which of its cards. */
  planId: string;
  filter: StudyFilter;
  /** The running focus block (interval_blocks.id): every answer carries it. */
  blockId: string;
  /** The block's full length and the focus time left, from the cycle's timer (pauses excluded). */
  blockMs: number;
  remainingMs: number;
  /** The cycle's clock (it ticks once a second while the screen is open). */
  now: number;
  /** The timer is paused: the card is hidden and nothing can be answered. */
  paused: boolean;
};

/**
 * The quiz-first study panel of a focus block (Phase 2, "Cycle integration"): recall first (learning
 * steps and due reviews, interleaved), then new cards (shown, then quizzed), then the closing
 * self-test in the block's last minutes, then free focus. The queue (hooks.ts useStudyQueue) decides
 * what comes next from the phone's database; this panel pins the card on screen and saves each
 * answer as one local transaction tagged with the block (studyRepo.answerCard), so it all works
 * offline and a restart picks up where the block was.
 *
 * The timer is not this panel's business: the focus screen keeps its ring, Pause, "End block early"
 * and the zero-tap handoff. When the block ends, the panel goes away with the card that was open
 * (nothing is written for it; it stays due). Paused: the card is hidden, so there is no peeking.
 */
export function StudyPanel({ planId, filter, blockId, blockMs, remainingMs, now, paused }: StudyPanelProps) {
  const { space } = useTheme();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const { plan, isLoading: planLoading } = usePlan(planId);
  const { prefs, isLoading: prefsLoading } = useStudyPrefs();
  const fsrsParams = useFsrsParams();
  const queue = useStudyQueue({ planId, blockId, scope: plan?.scope ?? 'single', filter, blockMs, remainingMs, now });
  const [open, setOpen] = useState<OpenCard | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const next = queue.next;
  const current = open !== null && open.blockId === blockId ? open : null;
  // Pin the card the queue offers (React's "adjust state while rendering"): it stays on screen until
  // it is answered, whatever the queue's choice becomes meanwhile. Not before the plan (its scope) and
  // this phone's settings (typed or not) are read, so the first card is the right one, asked the right way.
  const ready = !planLoading && !prefsLoading;
  if (current === null && ready && !paused && !saving && next?.type === 'card') {
    setOpen(openCard(next.card, blockId, now, answerModeFor(next.card, prefs)));
  }

  const buttons = ratingButtons(prefs.answerButtons);

  const save = async (card: OpenCard, grade: StudyGrade, outcome: AnswerOutcome) => {
    if (saving || !userId) return;
    const reviewId = card.reviewId ?? newId();
    const pinned = { ...card, reviewId };
    setOpen(pinned);
    setSaving(true);
    setProblem(null);
    try {
      const result = await answerCard({
        reviewId,
        userId,
        cardId: card.card.cardId,
        blockId,
        grade,
        answerMode: card.mode,
        answeredAt: Date.now(),
        shownAt: card.shownAt,
        fsrsParams,
      });
      haptic('select');
      queue.markAnswered(card.card.cardId, reviewId);
      setFeedback(feedbackLine(outcome, result));
      setOpen(null);
    } catch {
      setProblem(SAVE_PROBLEM);
    } finally {
      setSaving(false);
    }
  };

  const showAnswer = (card: OpenCard) => {
    const at = Date.now();
    let preview: Record<StudyGrade, number> | null = null;
    try {
      preview = previewDue(card.card.stateRow, at, schedulerFor(fsrsParams));
    } catch {
      // The buttons work without their hints.
    }
    setOpen(reveal(card, preview, at));
  };

  const check = (card: OpenCard) => {
    if (saving) return;
    const verdict = checkTypedAnswer(card.typed, card.card.answer);
    if (verdict.rating === RATING.good) {
      void save(card, RATING.good, { kind: 'typed_right', verdict });
    } else {
      haptic('warning');
      setOpen(markWrong(card, verdict));
    }
  };

  if (plan === null && !planLoading) {
    return (
      <Notice tone="neutral" title="This plan isn’t on this phone" message="Free focus until the timer ends." />
    );
  }
  if (plan !== null && plan.cardCount === 0) return <PlanNotReady planId={planId} />;

  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space[2] }}>
      <Text variant="label" tone="mind">
        {current ? reasonLabel(current.card.reason) : 'Study'}
      </Text>
      <Text variant="caption" tone="secondary">
        {countsLine(queue.counts) ?? ''}
      </Text>
    </View>
  );

  let body;
  if (paused) {
    body = (
      <Text tone="secondary" accessibilityLiveRegion="polite">
        Paused. Your card is hidden until you resume.
      </Text>
    );
  } else if (current) {
    body = (
      <CardView
        open={current}
        saving={saving}
        buttons={buttons}
        onQuiz={() => setOpen(quizMe(current, Date.now()))}
        onShowAnswer={() => showAnswer(current)}
        onType={(typed) => setOpen({ ...current, typed })}
        onCheck={() => check(current)}
        onRate={(grade) => void save(current, grade, { kind: 'graded', word: gradeWord(grade, buttons) })}
        onMissed={() => void save(current, RATING.again, { kind: 'typed_missed' })}
        onCounted={() => void save(current, RATING.good, { kind: 'typed_counted' })}
      />
    );
  } else if (next?.type === 'wait') {
    body = (
      <View style={{ gap: space[3] }}>
        <Text tone="secondary">{waitLine(next.until, now)}</Text>
        <Button
          label="Ask now"
          variant="secondary"
          accessibilityHint="Asks the next card before its time"
          onPress={() => setOpen(openCard(next.card, blockId, Date.now(), answerModeFor(next.card, prefs)))}
        />
      </View>
    );
  } else if (next?.type === 'done') {
    const done = doneMessage(next.reason);
    body = (
      <View style={{ gap: space[1] }} accessible accessibilityLiveRegion="polite">
        <Text variant="subtitle">{done.title}</Text>
        <Text tone="secondary">{done.detail}</Text>
      </View>
    );
  } else {
    body = (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
        <ActivityIndicator />
        <Text tone="secondary">Getting your cards…</Text>
      </View>
    );
  }

  return (
    <View style={{ alignSelf: 'stretch', gap: space[3] }}>
      {feedback ? (
        <Text variant="caption" tone="secondary" accessibilityLiveRegion="polite">
          {feedback}
        </Text>
      ) : null}
      {queue.scope.note ? (
        <Text variant="caption" tone="secondary">
          {queue.scope.note}
        </Text>
      ) : null}
      <Card tint="mind">
        {header}
        {body}
      </Card>
      {problem ? <Notice tone="danger" message={problem} /> : null}
    </View>
  );
}

type CardViewProps = {
  open: OpenCard;
  saving: boolean;
  buttons: ReturnType<typeof ratingButtons>;
  onQuiz(): void;
  onShowAnswer(): void;
  onType(text: string): void;
  onCheck(): void;
  onRate(grade: StudyGrade): void;
  onMissed(): void;
  onCounted(): void;
};

/** The pinned card at its stage, with the one action that moves it on. */
function CardView({ open, saving, buttons, onQuiz, onShowAnswer, onType, onCheck, onRate, onMissed, onCounted }: CardViewProps) {
  const { space } = useTheme();
  const { card, stage } = open;
  const note = reasonNote(card.reason, stage);
  const where = citation(card.page, card.sourceTitle);

  return (
    <View style={{ gap: space[3] }}>
      {note ? (
        <Text variant="caption" tone="secondary">
          {note}
        </Text>
      ) : null}
      <Text variant="subtitle" accessibilityLabel={`Question: ${card.question}`}>
        {card.question}
      </Text>
      {answerVisible(stage) ? (
        <View style={{ gap: space[1] }} accessible accessibilityLiveRegion="polite">
          {stage === 'wrong' ? (
            <Text variant="label" tone="warning">
              {open.typed.trim() ? `Not quite. You wrote: ${open.typed.trim()}` : 'Here’s the answer.'}
            </Text>
          ) : null}
          <Text variant="bodyLarge" accessibilityLabel={`Answer: ${card.answer}`}>
            {card.answer}
          </Text>
          {where ? (
            <Text variant="caption" tone="secondary">
              {where}
            </Text>
          ) : null}
        </View>
      ) : null}

      {stage === 'learn' ? (
        <Button label="Quiz me" accessibilityHint="Hides the answer and asks you" onPress={onQuiz} />
      ) : null}

      {stage === 'question' && open.mode === 'self_graded' ? (
        <Button label="Show answer" onPress={onShowAnswer} />
      ) : null}

      {stage === 'question' && open.mode === 'typed' ? (
        <>
          <TextField
            label="Your answer"
            hint="Leave it empty if you don’t know"
            value={open.typed}
            onChangeText={onType}
            returnKeyType="done"
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={onCheck}
            editable={!saving}
          />
          <Button label="Check" loading={saving} onPress={onCheck} />
        </>
      ) : null}

      {stage === 'revealed' ? (
        // At most two buttons a row: four in one row leave each label about 25 dp on a 360 dp phone
        // (after the screen, card and button padding), and "Again" needs about 42 dp at 16 sp, so
        // the words broke mid-word ("Aga/in") or were cut off with a larger font. Two a row leave
        // about 99 dp each. Four buttons: Again and Hard, then Good and Easy.
        <View style={{ gap: space[2] }}>
          {buttonRows(buttons).map((row) => (
            <View key={row[0].grade} style={{ flexDirection: 'row', gap: space[2] }}>
              {row.map((button) => {
                const hint = ratingHint(open, button.grade);
                return (
                  <View key={button.grade} style={{ flex: 1, gap: space[1], alignItems: 'stretch' }}>
                    <Button
                      label={button.label}
                      variant={button.grade === RATING.good ? 'primary' : 'secondary'}
                      disabled={saving}
                      accessibilityHint={hint ? `Comes back in ${hint}` : undefined}
                      onPress={() => onRate(button.grade)}
                    />
                    {hint ? (
                      <Text variant="caption" tone="secondary" align="center" importantForAccessibility="no">
                        {hint}
                      </Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      ) : null}

      {stage === 'wrong' ? (
        <View style={{ gap: space[2] }}>
          <Button label="I missed it" disabled={saving} onPress={onMissed} />
          <Button label="Count it as right" variant="secondary" disabled={saving} onPress={onCounted} />
        </View>
      ) : null}
    </View>
  );
}

/** The rating buttons in rows of at most two (see the comment where they are drawn). */
function buttonRows<T>(buttons: readonly T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
}

/** A plan without cards yet: its next step, and the block stays a plain timer. */
function PlanNotReady({ planId }: { planId: string }) {
  const { space } = useTheme();
  const { sources, nextStep, isLoading } = useSourceProgress(planId);
  const line = isLoading ? null : notReadyLine(nextStep, sources);
  return (
    <Card tint="mind">
      <View style={{ gap: space[1] }}>
        <Text variant="subtitle">No cards yet</Text>
        {line ? <Text tone="secondary">{line}</Text> : null}
        <Text tone="secondary">Free focus until the timer ends.</Text>
      </View>
    </Card>
  );
}
