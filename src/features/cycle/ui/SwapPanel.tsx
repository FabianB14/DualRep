import { Button, ListGroup, ListRow, Notice } from '@/components';
import { describeEquipment } from '@/features/training/equipment';
import { MOVEMENT_PATTERN_LABELS } from '@/features/training/library';
import type { LibraryExercise } from '@/features/training/types';

/** "Squat · Just your body", "Row · Dumbbells". */
export function describeAlternative(exercise: Pick<LibraryExercise, 'movementPattern' | 'equipment'>): string {
  const equipment = describeEquipment(exercise.equipment) || 'Just your body';
  return exercise.movementPattern ? `${MOVEMENT_PATTERN_LABELS[exercise.movementPattern]} · ${equipment}` : equipment;
}

export type SwapPanelProps = {
  /** Alternatives that fit the setup, best first (swap.ts alternativesFor). */
  options: readonly LibraryExercise[];
  onPick(exercise: LibraryExercise): void;
  onClose(): void;
};

/** The one-exercise swap: a short list of moves that fit the setup; one tap swaps. */
export function SwapPanel({ options, onPick, onClose }: SwapPanelProps) {
  if (options.length === 0) {
    return (
      <Notice
        message="Nothing else fits this setup right now. You can skip this one instead."
        action={<Button label="Close" variant="ghost" accent="body" onPress={onClose} />}
      />
    );
  }
  return (
    <>
      <ListGroup title="Swap for" description="These fit your setup. Your targets start fresh for the new exercise.">
        {options.map((exercise) => (
          <ListRow
            key={exercise.id}
            title={exercise.name}
            subtitle={describeAlternative(exercise)}
            accent="body"
            accessibilityHint="Swaps the current exercise for this one"
            onPress={() => onPick(exercise)}
          />
        ))}
      </ListGroup>
      <Button label="Keep this exercise" variant="ghost" accent="body" onPress={onClose} />
    </>
  );
}
