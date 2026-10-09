import { ScrollView, View } from 'react-native';

import { useTheme } from '@/theme';

import { Chip } from './Chip';
import { dateInDays, PLAN_GOAL_MAX, PLAN_TITLE_MAX, TARGET_DATE_CHOICES, type PlanDraft, type PlanDraftErrors } from './planDraft';
import { Section } from './Section';
import { SegmentedControl } from './SegmentedControl';
import { localDateMs, SCOPE_TEXT, targetDateText, type PlanScopeValue } from './studyText';
import { Text } from './Text';
import { TextField } from './TextField';

export type PlanFormProps = {
  draft: PlanDraft;
  onChange(patch: Partial<PlanDraft>): void;
  /** Shown under their fields (pass them once the person has tried to save). */
  errors?: PlanDraftErrors;
  /** "Now" for the date choices (epoch ms). */
  now: number;
  disabled?: boolean;
};

const SCOPES: readonly PlanScopeValue[] = ['cumulative', 'single'];

/**
 * A study plan's settings: its name, whether it is one source or a growing course, an optional goal
 * and an optional exam date. Used by "New plan" and "Plan settings"; the screen owns saving. The
 * date is one tap for the usual cases ("In 2 weeks") and can be typed for anything else.
 */
export function PlanForm({ draft, onChange, errors = {}, now, disabled = false }: PlanFormProps) {
  const { space } = useTheme();
  const date = draft.targetDate.trim();
  const dateValid = date !== '' && localDateMs(date) !== null;

  return (
    <>
      <TextField
        label="Name"
        value={draft.title}
        onChangeText={(title) => onChange({ title })}
        placeholder="For example: Biology 101"
        maxLength={PLAN_TITLE_MAX}
        autoCapitalize="sentences"
        returnKeyType="done"
        editable={!disabled}
        error={errors.title}
      />

      <View style={{ gap: space[2] }}>
        <SegmentedControl<PlanScopeValue>
          label="What will you add?"
          value={draft.scope}
          disabled={disabled}
          options={SCOPES.map((value) => ({
            value,
            label: SCOPE_TEXT[value].label,
            accessibilityLabel: `${SCOPE_TEXT[value].label}: ${SCOPE_TEXT[value].detail}`,
          }))}
          onChange={(scope) => onChange({ scope })}
        />
        <Text variant="caption" tone="secondary">
          {SCOPE_TEXT[draft.scope].detail}
        </Text>
      </View>

      <TextField
        label="Goal (optional)"
        value={draft.goal}
        onChangeText={(goal) => onChange({ goal })}
        placeholder="For example: pass the final with a B or better"
        hint="The card maker keeps it in mind."
        maxLength={PLAN_GOAL_MAX}
        multiline
        numberOfLines={3}
        editable={!disabled}
        error={errors.goal}
      />

      <Section title="Exam or deadline (optional)" description="New cards come a little sooner when a date is close.">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: space[2] }}
          accessibilityLabel="Quick dates"
        >
          <Chip label="No date" role="radio" selected={date === ''} disabled={disabled} onPress={() => onChange({ targetDate: '' })} />
          {TARGET_DATE_CHOICES.map((choice) => {
            const value = dateInDays(choice.days, now);
            return (
              <Chip
                key={choice.days}
                label={choice.label}
                role="radio"
                selected={date === value}
                disabled={disabled}
                accessibilityLabel={`${choice.label}, ${targetDateText(value, now)}`}
                onPress={() => onChange({ targetDate: value })}
              />
            );
          })}
        </ScrollView>
        <TextField
          label="Date"
          value={draft.targetDate}
          onChangeText={(targetDate) => onChange({ targetDate })}
          placeholder="Year-month-day, e.g. 2026-12-14"
          keyboardType="numbers-and-punctuation"
          autoCorrect={false}
          maxLength={10}
          editable={!disabled}
          error={errors.targetDate}
          hint={dateValid ? targetDateText(date, now) : 'Leave it empty for no date.'}
        />
      </Section>
    </>
  );
}
