/**
 * The start panel's choices and the cycle plan they make. Pure, so what "Start" sends is tested.
 *
 * Every choice has a default from the profile (block length, preset, setup); the panel keeps only
 * what the user changed and fills the rest in here, so defaults that load a moment later (the first
 * local read) still apply to everything the user has not touched. The study plan works the same way:
 * its default is the last choice made on this phone (study-defaults), as long as that plan is still
 * here.
 */
import type { SegmentedOption } from '@/components';
import { TEMPLATE_CHOICES } from '@/features/setups/setups';
import type { StudyFilter } from '@/features/study/queue';
import type { StudyPlan } from '@/features/study/studyQueries';
import type { StudyDefaults } from '@/features/study/studyPrefs';
import { SETUP_TEMPLATES } from '@/features/training/equipment';
import type { Setup, SetupLocation, Split } from '@/features/training/types';

import { CYCLE_RULES, type CyclePlanInput } from '../cycleMachine';

/** The move length control: a micro circuit of 5, 10 or 15 minutes, or a full session. */
export type MoveLength = '5' | '10' | '15' | 'full';

export const MOVE_LENGTH_OPTIONS: readonly SegmentedOption<MoveLength>[] = [
  ...CYCLE_RULES.microMinutes.map((minutes) => ({
    value: String(minutes) as MoveLength,
    label: `${minutes} min`,
    accessibilityLabel: `${minutes}-minute circuit`,
  })),
  { value: 'full', label: 'Full', accessibilityLabel: 'Full session' },
];

export const FULL_MINUTES_OPTIONS: readonly SegmentedOption<string>[] = CYCLE_RULES.fullMinutes.map((minutes) => ({
  value: String(minutes),
  label: `${minutes} min`,
  accessibilityLabel: `${minutes}-minute session`,
}));

export const DEFAULT_MOVE_LENGTH: MoveLength = String(CYCLE_RULES.defaultMicroMinutes) as MoveLength;

/** A one-tap setup choice before the user has any setup (it is saved as a setup too). */
export type QuickSetup = 'home_bodyweight' | 'gym';

const QUICK_HINTS: Readonly<Record<QuickSetup, string>> = {
  home_bodyweight: 'No equipment needed',
  gym: 'Machines, barbells, dumbbells and more',
};

/** The two choices, labelled as on the Setups screen (TEMPLATE_CHOICES). */
export const QUICK_SETUPS: readonly { template: QuickSetup; label: string; hint: string }[] = (
  ['home_bodyweight', 'gym'] as const
).map((template) => ({
  template,
  label: TEMPLATE_CHOICES.find((choice) => choice.template === template)?.label ?? template,
  hint: QUICK_HINTS[template],
}));

export type StartChoices = {
  focusSubject: string;
  blockMinutes: number;
  preset: { id: string; split: Split };
  /** The setup in use, or null when the user has none. */
  setup: Pick<Setup, 'id' | 'location' | 'equipment'> | null;
  /** The one-tap choice made while there was no setup yet (used until the new setup shows up). */
  quick: { template: QuickSetup; setupId: string | null } | null;
  moveLength: MoveLength;
  /** Minutes of a full session (30, 45 or 60). */
  fullMinutes: number;
  /** The study plan the focus blocks quiz from, or null / absent for just a timer. */
  study?: StudyChoice | null;
};

/** A study plan chosen on the start panel, with which of its cards. */
export type StudyChoice = { planId: string; title: string; filter: StudyFilter };

/** Where and with what the move block happens, or null when nothing is chosen yet. */
export function placeOf(choices: Pick<StartChoices, 'setup' | 'quick'>): {
  setupId: string | null;
  location: SetupLocation;
  equipment: string[];
} | null {
  if (choices.setup) {
    return { setupId: choices.setup.id, location: choices.setup.location, equipment: [...choices.setup.equipment] };
  }
  if (choices.quick) {
    const template = SETUP_TEMPLATES[choices.quick.template];
    return { setupId: choices.quick.setupId, location: template.location, equipment: [...template.equipment] };
  }
  return null;
}

/** The plan to start with, or null until a setup (or a one-tap choice) is there. */
export function planFromChoices(choices: StartChoices): CyclePlanInput | null {
  const place = placeOf(choices);
  if (!place) return null;
  const full = choices.moveLength === 'full';
  const study = choices.study ?? null;
  return {
    // With a plan, the session's subject is the plan's title (History and the top bar show it).
    focusSubject: (study ? study.title : choices.focusSubject).trim(),
    blockMinutes: choices.blockMinutes,
    presetId: choices.preset.id,
    split: { ...choices.preset.split },
    setupId: place.setupId,
    location: place.location,
    equipment: place.equipment,
    moveKind: full ? 'full' : 'micro',
    moveMinutes: full ? choices.fullMinutes : Number(choices.moveLength),
    // Only with a plan, so a timer-only plan is exactly what Phase 1 sent.
    ...(study ? { studyPlanId: study.planId, studyFilter: study.filter } : {}),
  };
}

/** The plan picker's choice: untouched (the default applies), or a plan id (null = just a timer). */
export type StudyPick = { planId: string | null; filter: StudyFilter } | null;

/**
 * The study plan the start panel uses: the user's pick, else the last choice on this phone
 * (study-defaults). A plan that is no longer on the phone (deleted, or its group left) falls back to
 * just a timer, never to a plan the user did not pick. Single-source plans always study everything.
 */
export function chosenStudy(
  pick: StudyPick,
  defaults: StudyDefaults | null,
  plans: readonly Pick<StudyPlan, 'id' | 'title' | 'scope'>[],
): StudyChoice | null {
  const wanted = pick ?? defaults;
  if (!wanted?.planId) return null;
  const plan = plans.find((entry) => entry.id === wanted.planId);
  if (!plan) return null;
  return { planId: plan.id, title: plan.title, filter: plan.scope === 'cumulative' ? wanted.filter : 'all' };
}

/** What a plan row says under its title: "12 due · 5 new", "Nothing due", "No cards yet". */
export function planChoiceSubtitle(plan: Pick<StudyPlan, 'cardCount' | 'dueCount' | 'newCount'>): string {
  if (plan.cardCount === 0) return 'No cards yet';
  const parts = [plan.dueCount > 0 ? `${plan.dueCount} due` : null, plan.newCount > 0 ? `${plan.newCount} new` : null];
  const said = parts.filter((part): part is string => part !== null);
  return said.length > 0 ? said.join(' · ') : 'Nothing due';
}

/** The filter of a cumulative plan: every source so far (interleaved), or only the newest one. */
export const STUDY_FILTER_OPTIONS: readonly SegmentedOption<StudyFilter>[] = [
  { value: 'all', label: 'Everything so far', accessibilityLabel: 'Everything so far' },
  { value: 'newest', label: 'Newest source', accessibilityLabel: 'Newest source only' },
];

/** The line under the filter: what it means for this plan. */
export function studyFilterNote(filter: StudyFilter, sourceCount: number, newestTitle: string | null): string {
  if (filter === 'newest') return newestTitle ? `Only ${newestTitle}.` : 'Only the newest source.';
  return `All ${sourceCount} sources, mixed together.`;
}

/** The filter is offered for a cumulative plan with more than one source (otherwise both are the same). */
export function offersStudyFilter(plan: Pick<StudyPlan, 'scope' | 'sourceCount'> | null): boolean {
  return plan !== null && plan.scope === 'cumulative' && plan.sourceCount > 1;
}
