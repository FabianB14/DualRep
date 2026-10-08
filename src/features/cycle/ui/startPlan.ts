/**
 * The start panel's choices and the cycle plan they make. Pure, so what "Start" sends is tested.
 *
 * Every choice has a default from the profile (block length, preset, setup); the panel keeps only
 * what the user changed and fills the rest in here, so defaults that load a moment later (the first
 * local read) still apply to everything the user has not touched.
 */
import type { SegmentedOption } from '@/components';
import { TEMPLATE_CHOICES } from '@/features/setups/setups';
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
};

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
  return {
    focusSubject: choices.focusSubject.trim(),
    blockMinutes: choices.blockMinutes,
    presetId: choices.preset.id,
    split: { ...choices.preset.split },
    setupId: place.setupId,
    location: place.location,
    equipment: place.equipment,
    moveKind: full ? 'full' : 'micro',
    moveMinutes: full ? choices.fullMinutes : Number(choices.moveLength),
  };
}
