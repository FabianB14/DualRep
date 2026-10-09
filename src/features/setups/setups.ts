/**
 * Equipment setups: the places the user trains, each with the gear checked off there
 * (docs/EXECUTION_PLAN.md "Gym or home"). A user can have several; one is the default
 * (profiles.default_setup_id), and when none is chosen the first one made is used.
 *
 * Stored equipment is always the vocabulary of equipment.ts, without `bodyweight` (it is implicit),
 * deduplicated and in vocabulary order (normalizeEquipmentList), so two setups with the same gear
 * store the same JSON.
 *
 * Pure: no React, no database. setupsRepo.ts writes, useSetups.ts reads.
 */
import type { EquipmentSetupRow } from '@/db/schema';
import {
  describeEquipment,
  EQUIPMENT_LABELS,
  GYM_ONLY_EQUIPMENT,
  normalizeEquipmentList,
  SETUP_TEMPLATES,
  type Equipment,
} from '@/features/training/equipment';
import { parseStringArray } from '@/features/training/library';
import type { Setup, SetupLocation } from '@/features/training/types';

/** equipment_setups.name is 1–60 characters (CHECK). */
export const SETUP_NAME_MAX = 60;

export const SETUP_LOCATIONS: readonly SetupLocation[] = ['home', 'gym'];

export const LOCATION_LABELS: Readonly<Record<SetupLocation, string>> = { home: 'Home', gym: 'Gym' };

export type SetupTemplate = keyof typeof SETUP_TEMPLATES;

/** The one-tap starting points, in the order they are offered, with the name a new setup gets. */
export const TEMPLATE_CHOICES: readonly { template: SetupTemplate; label: string; name: string }[] = [
  { template: 'home_bodyweight', label: 'Home, just my body', name: 'Home' },
  { template: 'home_basic', label: 'Home with dumbbells and bands', name: 'Home with weights' },
  { template: 'gym', label: 'Gym', name: 'Gym' },
];

export type SetupDraft = { name: string; location: SetupLocation; equipment: Equipment[] };

/** A synced equipment_setups row as a Setup (bad JSON reads as no equipment; unknown items are dropped). */
export function setupFromRow(row: Pick<EquipmentSetupRow, 'id' | 'name' | 'location' | 'equipment'>): Setup {
  const equipment = normalizeEquipmentList(parseStringArray(row.equipment));
  const location: SetupLocation =
    row.location === 'gym' || row.location === 'home'
      ? row.location
      : equipment.some((item) => GYM_ONLY_EQUIPMENT.includes(item))
        ? 'gym'
        : 'home';
  const name = (typeof row.name === 'string' ? row.name.trim() : '') || LOCATION_LABELS[location];
  return { id: row.id, name, location, equipment };
}

/**
 * The setup to train with: the default when it is still there, else the first setup (the list is in
 * creation order), else null (the user has none yet).
 */
export function resolveSetup(setups: readonly Setup[], defaultSetupId: string | null | undefined): Setup | null {
  return (defaultSetupId ? setups.find((setup) => setup.id === defaultSetupId) : undefined) ?? setups[0] ?? null;
}

/** `base`, or `base 2`, `base 3` … when that name is taken (ignoring case). */
export function uniqueName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** A draft filled in from a template, named so it does not repeat an existing setup's name. */
export function templateDraft(template: SetupTemplate, takenNames: readonly string[] = []): SetupDraft {
  const choice = TEMPLATE_CHOICES.find((entry) => entry.template === template);
  const { location, equipment } = SETUP_TEMPLATES[template];
  return {
    name: uniqueName(choice?.name ?? LOCATION_LABELS[location], takenNames),
    location,
    equipment: normalizeEquipmentList(equipment),
  };
}

/** A blank draft for the editor ("Home", nothing checked). */
export function emptySetupDraft(takenNames: readonly string[] = []): SetupDraft {
  return { name: uniqueName('Home', takenNames), location: 'home', equipment: [] };
}

/** The list with `item` checked or unchecked (normalized). */
export function toggleEquipment(list: readonly Equipment[], item: Equipment): Equipment[] {
  return normalizeEquipmentList(list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item]);
}

/** What is wrong with a draft, in plain words; an empty object when it can be saved. */
export function setupDraftErrors(draft: SetupDraft): { name?: string } {
  const name = draft.name.trim();
  if (name.length === 0) return { name: 'Give it a name.' };
  if (name.length > SETUP_NAME_MAX) return { name: `Use at most ${SETUP_NAME_MAX} characters.` };
  return {};
}

/** "Home · just your body", "Gym · 20 items", "Home · Dumbbells, Resistance bands". */
export function describeSetup(setup: Pick<Setup, 'location' | 'equipment'>): string {
  const place = LOCATION_LABELS[setup.location];
  const items = setup.equipment.filter((item): item is Equipment => item in EQUIPMENT_LABELS && item !== 'bodyweight');
  if (items.length === 0) return `${place} · just your body`;
  if (items.length <= 2) return `${place} · ${describeEquipment(items)}`;
  return `${place} · ${items.length} items`;
}

/** True when a draft differs from the saved setup (to warn before leaving unsaved changes). */
export function draftChanged(draft: SetupDraft, saved: Pick<Setup, 'name' | 'location' | 'equipment'>): boolean {
  return (
    draft.name.trim() !== saved.name ||
    draft.location !== saved.location ||
    draft.equipment.join(',') !== normalizeEquipmentList(saved.equipment).join(',')
  );
}
