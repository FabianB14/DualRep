import { View } from 'react-native';

import { useTheme } from '@/theme';

import { Button } from './Button';

export type ReorderButtonsProps = {
  /** Spoken name of the item, e.g. "Photosynthesis" or "Page 2": "Move Photosynthesis up". */
  itemLabel: string;
  index: number;
  count: number;
  onMove(delta: -1 | 1): void;
  /** Adds a third button (e.g. "Remove", "Cut"). */
  extra?: { label: string; onPress(): void; accessibilityLabel?: string };
  disabled?: boolean;
};

/**
 * Move up / Move down for one item of an ordered list (the outline review, the pages of a set of
 * notes): real buttons, each a 48 dp target with its own label, so reordering never needs dragging
 * and works with TalkBack and Switch Access. A button turns inactive at the end of the list. Pair it
 * with `reorderActions` on the row so screen-reader users can also use the actions menu.
 */
export function ReorderButtons({ itemLabel, index, count, onMove, extra, disabled = false }: ReorderButtonsProps) {
  const { space } = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
      <Button
        label="Move up"
        variant="secondary"
        fullWidth={false}
        disabled={disabled || index <= 0}
        accessibilityLabel={`Move ${itemLabel} up`}
        onPress={() => onMove(-1)}
      />
      <Button
        label="Move down"
        variant="secondary"
        fullWidth={false}
        disabled={disabled || index >= count - 1}
        accessibilityLabel={`Move ${itemLabel} down`}
        onPress={() => onMove(1)}
      />
      {extra ? (
        <Button
          label={extra.label}
          variant="ghost"
          fullWidth={false}
          disabled={disabled}
          accessibilityLabel={extra.accessibilityLabel ?? `${extra.label} ${itemLabel}`}
          onPress={extra.onPress}
        />
      ) : null}
    </View>
  );
}

/** The same moves as screen-reader actions ("Actions available: Move up, Move down"). */
export function reorderActions(index: number, count: number): { name: 'moveUp' | 'moveDown'; label: string }[] {
  const actions: { name: 'moveUp' | 'moveDown'; label: string }[] = [];
  if (index > 0) actions.push({ name: 'moveUp', label: 'Move up' });
  if (index < count - 1) actions.push({ name: 'moveDown', label: 'Move down' });
  return actions;
}
