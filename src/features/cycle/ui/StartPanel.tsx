import { useQuery } from '@powersync/react-native';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import {
  Button,
  Chip,
  ListGroup,
  ListRow,
  Notice,
  Screen,
  SegmentedControl,
  Stepper,
  Text,
  TextField,
} from '@/components';
import { describeSplit } from '@/features/presets/presets';
import { usePresets } from '@/features/presets/usePresets';
import { formatMinutes } from '@/features/settings/profile';
import { useTrainingDefaults } from '@/features/settings/useTrainingDefaults';
import { describeSetup } from '@/features/setups/setups';
import { createSetupFromTemplate } from '@/features/setups/setupsRepo';
import { useSetups } from '@/features/setups/useSetups';
import { usePlans } from '@/features/study/hooks';
import { PLAN_SOURCES_SQL, type PlanSourceRow } from '@/features/study/studyQueries';
import { parseStudyDefaults, saveStudyDefaults, STUDY_DEFAULTS_KEY } from '@/features/study/studyPrefs';
import type { NotificationPermission } from '@/features/timer/notifications';
import { useTheme } from '@/theme';

import { CYCLE_RULES, type CyclePlanInput } from '../cycleMachine';
import { useLocalState } from '../localState';
import {
  chosenStudy,
  DEFAULT_MOVE_LENGTH,
  FULL_MINUTES_OPTIONS,
  MOVE_LENGTH_OPTIONS,
  offersStudyFilter,
  planChoiceSubtitle,
  planFromChoices,
  QUICK_SETUPS,
  STUDY_FILTER_OPTIONS,
  studyFilterNote,
  type MoveLength,
  type QuickSetup,
  type StartChoices,
  type StudyPick,
} from './startPlan';
import { TopBar } from './TopBar';

/** focus_subject is stored as given; the plan keeps at most this many characters. */
const SUBJECT_MAX = 200;

export type StartPanelProps = {
  /** 'study' starts a focus block; 'move' ("Just train") a workout on its own. */
  mode: 'study' | 'move';
  permission: NotificationPermission | null;
  requestPermission(): Promise<NotificationPermission>;
  onStart(plan: CyclePlanInput): void;
  /** Resolves to false when no workout could be started. */
  onStartMove(plan: CyclePlanInput): Promise<boolean>;
  error: string | null;
};

/**
 * The start panel. Everything starts from the user's defaults (block length, preset, setup), so one
 * tap on Start is enough; each choice can be changed for this cycle only (the defaults live in
 * Settings, Presets and Setups). A user with no setup yet gets two big one-tap choices, "Home, just
 * my body" and "Gym", which save a setup from its template.
 *
 * Notifications: before the first block ever starts (the permission is still undetermined), one line
 * says why DualRep will ask, and Start asks. A "no" changes nothing but a quiet note: the timer works
 * on screen, there is just no alert.
 *
 * Studying a plan: when the phone has study plans, "What are you studying?" picks one (with its cards
 * due and new) or "Just a timer"; a cumulative plan with several sources also picks everything so far
 * or the newest source. The last choice is remembered on this phone and preselected, so one tap on
 * Start still starts. Without any plan the panel is exactly Phase 1's: a free-text subject.
 */
export function StartPanel({ mode, permission, requestPermission, onStart, onStartMove, error }: StartPanelProps) {
  const { space } = useTheme();
  const { user } = useAuth();
  const defaults = useTrainingDefaults();
  const presets = usePresets();
  const { setups, isLoading: setupsLoading } = useSetups();
  const studying = mode === 'study';

  const [subject, setSubject] = useState('');
  const [blockMinutes, setBlockMinutes] = useState<number | null>(null);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [setupId, setSetupId] = useState<string | null>(null);
  const [quick, setQuick] = useState<StartChoices['quick']>(null);
  const [creating, setCreating] = useState(false);
  const [moveLength, setMoveLength] = useState<MoveLength>(DEFAULT_MOVE_LENGTH);
  const [fullMinutes, setFullMinutes] = useState<number>(CYCLE_RULES.defaultFullMinutes);
  const [open, setOpen] = useState<'preset' | 'setup' | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [studyPick, setStudyPick] = useState<StudyPick>(null);

  const { plans } = usePlans();
  const storedStudy = useLocalState<unknown>(STUDY_DEFAULTS_KEY).value;
  const studyDefaults = useMemo(() => (storedStudy === null ? null : parseStudyDefaults(storedStudy)), [storedStudy]);
  const offersPlans = studying && plans.length > 0;
  const study = offersPlans ? chosenStudy(studyPick, studyDefaults, plans) : null;
  const studyPlan = study ? (plans.find((entry) => entry.id === study.planId) ?? null) : null;
  // The plan's sources, newest first: the newest one's title explains the filter.
  const { data: studySources } = useQuery<PlanSourceRow>(PLAN_SOURCES_SQL, [study?.planId ?? '']);
  const newestSource = studySources[0]?.title?.trim() || null;

  const preset = (presetId ? presets.byId.get(presetId) : undefined) ?? defaults.preset;
  const setup = (setupId ? setups.find((entry) => entry.id === setupId) : undefined) ?? defaults.setup;
  const plan = planFromChoices({
    focusSubject: subject,
    blockMinutes: blockMinutes ?? defaults.blockMinutes,
    preset,
    setup,
    quick,
    moveLength,
    fullMinutes,
    study,
  });

  const pickPlan = (planId: string | null) => {
    setStudyPick({ planId, filter: planId !== null && planId === study?.planId ? study.filter : 'all' });
  };

  const chooseQuick = (template: QuickSetup) => {
    if (creating) return;
    setQuick({ template, setupId: null });
    if (!user) return;
    setCreating(true);
    createSetupFromTemplate(
      user.id,
      template,
      setups.map((entry) => entry.name),
      { makeDefault: true },
    )
      .then((id) => setQuick((current) => (current?.template === template ? { template, setupId: id } : current)))
      // Not saved: this cycle still uses the template; the setup can be added later in Setups.
      .catch(() => undefined)
      .finally(() => setCreating(false));
  };

  const start = async () => {
    // While the one-tap setup is being saved (a few ms on the phone) wait, so the workout points at it.
    if (!plan || busy || creating) return;
    setProblem(null);
    if (!studying) {
      setBusy(true);
      const started = await onStartMove(plan).catch(() => false);
      setBusy(false);
      if (!started) setProblem('Couldn’t put a workout together for this setup. Try another setup or preset.');
      return;
    }
    if (permission === 'undetermined') {
      setBusy(true);
      // The answer only decides whether the block-end alert can ring; the block starts either way.
      await requestPermission().catch(() => undefined);
      setBusy(false);
    }
    // Remembered for next time; a failed save only means the next panel offers the earlier choice.
    if (offersPlans) {
      saveStudyDefaults({ planId: study?.planId ?? null, filter: study?.filter ?? 'all' }).catch(() => undefined);
    }
    onStart(plan);
  };

  const footer = (
    <>
      {!plan && !setupsLoading ? (
        <Text variant="caption" tone="secondary" align="center">
          Pick where you’re training first.
        </Text>
      ) : null}
      <Button
        label={studying ? 'Start focus block' : 'Start workout'}
        accent={studying ? 'mind' : 'body'}
        size="comfortable"
        disabled={!plan || creating}
        loading={busy}
        onPress={() => void start()}
      />
    </>
  );

  return (
    <Screen footer={footer}>
      <TopBar
        title={studying ? 'Study block' : 'Just train'}
        subtitle={studying ? 'Focus, then move' : 'A workout on its own'}
        accent={studying ? 'mind' : 'body'}
      />
      {error ? <Notice tone="warning" message={error} /> : null}

      {offersPlans ? (
        <View style={{ gap: space[3] }}>
          <ListGroup title="What are you studying?" description="A plan’s cards come up during each focus block.">
            <ListRow
              title="Just a timer"
              subtitle="No cards"
              accessory="radio"
              checked={study === null}
              onPress={() => pickPlan(null)}
            />
            {plans.map((entry) => (
              <ListRow
                key={entry.id}
                title={entry.title || 'Untitled plan'}
                subtitle={planChoiceSubtitle(entry)}
                accessory="radio"
                checked={study?.planId === entry.id}
                onPress={() => pickPlan(entry.id)}
              />
            ))}
          </ListGroup>
          {study && offersStudyFilter(studyPlan) ? (
            <>
              <SegmentedControl
                label="Cards"
                options={STUDY_FILTER_OPTIONS}
                value={study.filter}
                onChange={(filter) => setStudyPick({ planId: study.planId, filter })}
              />
              <Text variant="caption" tone="secondary">
                {studyFilterNote(study.filter, studyPlan?.sourceCount ?? 0, newestSource)}
              </Text>
            </>
          ) : null}
          {studyPlan && studyPlan.cardCount === 0 ? (
            <Text variant="caption" tone="secondary">
              This plan has no cards yet. The block runs as a plain timer until they’re ready.
            </Text>
          ) : null}
        </View>
      ) : null}

      {studying ? (
        <>
          {study === null ? (
            <TextField
              label={offersPlans ? 'Subject' : 'What are you studying?'}
              hint="Optional"
              value={subject}
              onChangeText={setSubject}
              maxLength={SUBJECT_MAX}
              returnKeyType="done"
              autoCapitalize="sentences"
            />
          ) : null}
          <Stepper
            label="Focus block"
            value={blockMinutes ?? defaults.blockMinutes}
            min={CYCLE_RULES.blockMinutes.min}
            max={CYCLE_RULES.blockMinutes.max}
            step={CYCLE_RULES.blockMinutes.step}
            format={formatMinutes}
            size="comfortable"
            onChange={setBlockMinutes}
          />
        </>
      ) : null}

      <View style={{ gap: space[3] }}>
        <Text variant="subtitle" accessibilityRole="header">
          {studying ? 'Then move' : 'Workout'}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          <Chip
            label={`Preset: ${preset.name}`}
            accent="body"
            accessibilityHint="Choose how the workout is split across the body"
            onPress={() => setOpen(open === 'preset' ? null : 'preset')}
          />
          {setup ? (
            <Chip
              label={`Setup: ${setup.name}`}
              accent="body"
              accessibilityHint="Choose where you’re training"
              onPress={() => setOpen(open === 'setup' ? null : 'setup')}
            />
          ) : null}
        </View>

        {open === 'preset' ? (
          <ListGroup title="Preset" description="For this cycle only. Your default is set in Presets.">
            {presets.all.map((entry) => (
              <ListRow
                key={entry.id}
                title={entry.name}
                subtitle={describeSplit(entry.split)}
                accessory="radio"
                accent="body"
                checked={entry.id === preset.id}
                onPress={() => {
                  setPresetId(entry.id);
                  setOpen(null);
                }}
              />
            ))}
          </ListGroup>
        ) : null}

        {open === 'setup' && setup ? (
          <ListGroup title="Setup" description="For this cycle only. Your default is set in Setups.">
            {setups.map((entry) => (
              <ListRow
                key={entry.id}
                title={entry.name}
                subtitle={describeSetup(entry)}
                accessory="radio"
                accent="body"
                checked={entry.id === setup.id}
                onPress={() => {
                  setSetupId(entry.id);
                  setOpen(null);
                }}
              />
            ))}
          </ListGroup>
        ) : null}

        {/* Only once the setups have been read: a user who has one must never see (and tap) these. */}
        {!setup && !setupsLoading ? (
          <ListGroup title="Where are you training?" description="One tap saves it as your setup. Add gear later in Setups.">
            {QUICK_SETUPS.map((choice) => (
              <ListRow
                key={choice.template}
                title={choice.label}
                subtitle={choice.hint}
                accessory="radio"
                accent="body"
                checked={quick?.template === choice.template}
                disabled={creating}
                onPress={() => chooseQuick(choice.template)}
              />
            ))}
          </ListGroup>
        ) : null}

        <SegmentedControl<MoveLength>
          label={studying ? 'Workout length' : 'Length'}
          options={MOVE_LENGTH_OPTIONS}
          value={moveLength}
          accent="body"
          onChange={setMoveLength}
        />
        {moveLength === 'full' ? (
          <SegmentedControl
            label="Full session"
            options={FULL_MINUTES_OPTIONS}
            value={String(fullMinutes)}
            accent="body"
            onChange={(value) => setFullMinutes(Number(value))}
          />
        ) : null}
      </View>

      {studying && permission === 'undetermined' ? (
        <Text variant="caption" tone="secondary">
          When you start, DualRep asks to send one alert when the block ends, so you can lock your phone.
        </Text>
      ) : null}
      {studying && permission === 'denied' ? (
        <Notice
          title="Alerts are off"
          tone="neutral"
          message="The timer still runs on screen. Turn on notifications in Settings to get an alert when a block ends."
        />
      ) : null}
      {problem ? <Notice tone="danger" message={problem} /> : null}
    </Screen>
  );
}
