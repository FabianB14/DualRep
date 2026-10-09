import { View } from 'react-native';

import { SegmentedControl, Text, type SegmentedOption } from '@/components';
import { useTheme } from '@/theme';

import { CYCLE_RULES } from '../cycleMachine';

type Rating = '1' | '2' | '3' | '4' | '5';

const WORDS: Readonly<Record<Rating, string>> = { '1': 'rough', '2': 'so-so', '3': 'okay', '4': 'good', '5': 'great' };

const OPTIONS: readonly SegmentedOption<Rating>[] = (['1', '2', '3', '4', '5'] as const).map((value) => ({
  value,
  label: value,
  accessibilityLabel: `${value}, ${WORDS[value]}`,
}));

export type BlockRatingProps = {
  /** The rating given, 1–5, or null. */
  value: number | null;
  onRate(effort: number): void;
};

/**
 * "How was that focus block? 1–5" (interval_blocks.effort_rating). Optional and non-blocking: it sits
 * below the workout and the return countdown, and nothing waits for it. A new tap changes the rating.
 */
export function BlockRating({ value, onRate }: BlockRatingProps) {
  const { space } = useTheme();
  const selected = value !== null && value >= CYCLE_RULES.effort.min && value <= CYCLE_RULES.effort.max;
  return (
    <View style={{ gap: space[1] }}>
      <SegmentedControl<Rating | ''>
        label="How was that focus block?"
        options={OPTIONS}
        value={selected ? (String(value) as Rating) : ''}
        onChange={(next) => {
          if (next !== '') onRate(Number(next));
        }}
      />
      <Text variant="caption" tone="secondary" accessibilityLiveRegion="polite">
        {selected ? `Saved: ${value}, ${WORDS[String(value) as Rating]}.` : '1 is rough, 5 is great. Optional.'}
      </Text>
    </View>
  );
}
