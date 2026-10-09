/**
 * Focus presets: how a move block's working sets are split between lower body, upper body, core and
 * cardio (docs/EXECUTION_PLAN.md "Focus presets").
 *
 * The six system presets are seeded by the first migration and sync like any row, but the app also
 * bundles them (SYSTEM_PRESETS), so the presets screen, the Home defaults and the circuit builder work
 * offline before the first sync. A synced system row replaces the bundled copy with the same id (the
 * server may tune a split); presets.test.ts checks the bundled copy against the migration.
 *
 * A custom preset is the user's own row (owner_id = the user, kind 'custom'). Its split must have
 * exactly the four keys, each a whole number from 0 to 100, adding up to 100 (the server's
 * is_valid_split CHECK; the editor uses steps of 5).
 *
 * Pure: no React, no database. presetsRepo.ts writes, usePresets.ts reads.
 */
import { SYSTEM_PRESET_IDS, type SystemPresetKind } from '@/db/constants';
import type { PresetRow } from '@/db/schema';
import { SPLIT_REGIONS, type Split, type SplitRegion } from '@/features/training/types';

export type PresetKind = SystemPresetKind | 'custom';

export type Preset = {
  id: string;
  name: string;
  kind: PresetKind;
  split: Split;
  /** null for a system preset. */
  ownerId: string | null;
  /** True for the six read-only presets everyone shares. */
  system: boolean;
};

/** The system presets exactly as supabase/migrations/20261008000000_initial_schema.sql seeds them. */
export const SYSTEM_PRESETS: readonly Preset[] = (
  [
    ['all_lower', 'All lower body', { lower: 100, upper: 0, core: 0, cardio: 0 }],
    ['mostly_lower', 'Mostly lower body', { lower: 70, upper: 15, core: 15, cardio: 0 }],
    ['full_body', 'Full body', { lower: 25, upper: 50, core: 25, cardio: 0 }],
    ['mostly_upper', 'Mostly upper body', { lower: 15, upper: 70, core: 15, cardio: 0 }],
    ['all_upper', 'All upper body', { lower: 0, upper: 100, core: 0, cardio: 0 }],
    ['mostly_cardio', 'Mostly cardio', { lower: 10, upper: 10, core: 10, cardio: 70 }],
  ] as const satisfies readonly (readonly [SystemPresetKind, string, Split])[]
).map(([kind, name, split]) => ({ id: SYSTEM_PRESET_IDS[kind], name, kind, split: { ...split }, ownerId: null, system: true }));

/** The preset used when none is chosen (or the chosen one is gone): even across the body. */
export const DEFAULT_PRESET_ID: string = SYSTEM_PRESET_IDS.full_body;

/** presets.name is 1–60 characters (CHECK). */
export const PRESET_NAME_MAX = 60;

/** A split's percentages move in steps of this size in the editor. */
export const SPLIT_STEP = 5;

export const SPLIT_REGION_LABELS: Readonly<Record<SplitRegion, string>> = {
  lower: 'Lower body',
  upper: 'Upper body',
  core: 'Core',
  cardio: 'Cardio',
};

const PRESET_KINDS: readonly PresetKind[] = [...(Object.keys(SYSTEM_PRESET_IDS) as SystemPresetKind[]), 'custom'];

/** The sum of a split's four parts. */
export function splitTotal(split: Split): number {
  return SPLIT_REGIONS.reduce((sum, region) => sum + split[region], 0);
}

/**
 * A split the server accepts: exactly the four keys, each a number from 0 to 100, adding up to 100.
 * (The server allows fractions; the app only ever writes whole numbers.)
 */
export function isValidSplit(value: unknown): value is Split {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== SPLIT_REGIONS.length || !SPLIT_REGIONS.every((region) => keys.includes(region))) return false;
  const parts = SPLIT_REGIONS.map((region) => (value as Record<string, unknown>)[region]);
  if (!parts.every((part) => typeof part === 'number' && Number.isFinite(part) && part >= 0 && part <= 100)) return false;
  return Math.abs((parts as number[]).reduce((sum, part) => sum + part, 0) - 100) < 1e-9;
}

/** A split column (JSON text, or an already-parsed object) as a Split, or null when it is not valid. */
export function parseSplit(value: unknown): Split | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isValidSplit(parsed)) return null;
  return { lower: parsed.lower, upper: parsed.upper, core: parsed.core, cardio: parsed.cardio };
}

/** A synced presets row as a Preset; null when its split cannot be used (it is then not offered). */
export function presetFromRow(row: Pick<PresetRow, 'id' | 'owner_id' | 'name' | 'kind' | 'split'>): Preset | null {
  const split = parseSplit(row.split);
  if (!split || typeof row.id !== 'string' || row.id === '') return null;
  const ownerId = typeof row.owner_id === 'string' && row.owner_id !== '' ? row.owner_id : null;
  const kind = PRESET_KINDS.find((k) => k === row.kind) ?? 'custom';
  const name = (typeof row.name === 'string' ? row.name.trim() : '') || 'Unnamed preset';
  return { id: row.id, name, kind, split, ownerId, system: ownerId === null };
}

export type PresetList = {
  /** The system presets in their fixed order (bundled copies until the rows sync). */
  system: Preset[];
  /** The user's own presets, by name. */
  custom: Preset[];
  /** system then custom. */
  all: Preset[];
  byId: ReadonlyMap<string, Preset>;
};

/**
 * Every preset the user can pick: the system presets (a synced row replaces its bundled copy; a
 * system row this app version does not know is added after them) and the user's own presets. Rows
 * owned by anyone else are left out.
 */
export function mergePresets(rows: readonly Parameters<typeof presetFromRow>[0][], userId: string | null): PresetList {
  const parsed = rows.map(presetFromRow).filter((preset): preset is Preset => preset !== null);
  const syncedSystem = new Map(parsed.filter((preset) => preset.system).map((preset) => [preset.id, preset]));
  const bundledIds = new Set(SYSTEM_PRESETS.map((preset) => preset.id));
  const system = [
    ...SYSTEM_PRESETS.map((preset) => syncedSystem.get(preset.id) ?? preset),
    ...[...syncedSystem.values()].filter((preset) => !bundledIds.has(preset.id)).sort(compareByName),
  ];
  const custom = parsed.filter((preset) => !preset.system && userId !== null && preset.ownerId === userId).sort(compareByName);
  const all = [...system, ...custom];
  return { system, custom, all, byId: new Map(all.map((preset) => [preset.id, preset])) };
}

function compareByName(a: Preset, b: Preset): number {
  const nameA = a.name.toLowerCase();
  const nameB = b.name.toLowerCase();
  if (nameA !== nameB) return nameA < nameB ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The preset to use: the chosen one when it is still there, else Full body. */
export function resolvePreset(list: Pick<PresetList, 'byId'>, presetId: string | null | undefined): Preset {
  return (
    (presetId ? list.byId.get(presetId) : undefined) ??
    list.byId.get(DEFAULT_PRESET_ID) ??
    (SYSTEM_PRESETS.find((preset) => preset.id === DEFAULT_PRESET_ID) as Preset)
  );
}

/** "Lower 70% · Upper 15% · Core 15%" (regions at 0% are left out). */
export function describeSplit(split: Split): string {
  const parts = SPLIT_REGIONS.filter((region) => split[region] > 0).map(
    (region) => `${SHORT_REGION[region]} ${split[region]}%`,
  );
  return parts.length > 0 ? parts.join(' · ') : 'Nothing chosen';
}

const SHORT_REGION: Readonly<Record<SplitRegion, string>> = {
  lower: 'Lower',
  upper: 'Upper',
  core: 'Core',
  cardio: 'Cardio',
};

export type PresetDraft = { name: string; split: Split };

/** A new custom preset: empty name, starting from `from`'s split (or Full body's). */
export function newPresetDraft(from?: Pick<Preset, 'split'> | null): PresetDraft {
  const base = from?.split ?? (SYSTEM_PRESETS.find((preset) => preset.id === DEFAULT_PRESET_ID) as Preset).split;
  return { name: '', split: { ...base } };
}

/** What is wrong with a draft, in plain words; an empty object when it can be saved. */
export function presetDraftErrors(draft: PresetDraft): { name?: string; split?: string } {
  const errors: { name?: string; split?: string } = {};
  const name = draft.name.trim();
  if (name.length === 0) errors.name = 'Give it a name.';
  else if (name.length > PRESET_NAME_MAX) errors.name = `Use at most ${PRESET_NAME_MAX} characters.`;
  const parts = SPLIT_REGIONS.map((region) => draft.split[region]);
  if (!parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 100)) {
    errors.split = 'Each part must be a whole number from 0 to 100.';
  } else {
    const total = splitTotal(draft.split);
    if (total < 100) errors.split = `Add ${100 - total}% more: the parts must add up to 100%.`;
    else if (total > 100) errors.split = `Take away ${total - 100}%: the parts must add up to 100%.`;
  }
  return errors;
}

/** True when two splits are the same. */
export function sameSplit(a: Split, b: Split): boolean {
  return SPLIT_REGIONS.every((region) => a[region] === b[region]);
}
