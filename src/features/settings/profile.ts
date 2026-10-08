/**
 * The signed-in user's settings as the screens see them: the synced `profiles` row read defensively,
 * with defaults for everything, plus the validated UPDATE the device may send.
 *
 * Why defaults matter: the profile row is created on the server (handle_new_user) and reaches the
 * phone with the first sync. Until then (a fresh install that went offline right after signing in)
 * there is no row, and the device must not insert one (the server owns its creation). Every screen
 * keeps working with the same defaults the server would have used (25-minute blocks, pounds, no
 * default preset or setup), and changes are offered once the row has arrived (`synced`).
 *
 * Pure: no React, no database. profileRepo.ts writes, useProfile.ts reads.
 */
import { TABLE } from '@/db/constants';
import type { ProfileRow } from '@/db/schema';
import { CYCLE_RULES } from '@/features/cycle/cycleMachine';
import type { Unit } from '@/features/training/types';
import { isoTimestamp } from '@/lib/time';

/** Focus block length the app offers, in minutes (the same range as profiles.default_block_minutes). */
export const BLOCK_MINUTES = CYCLE_RULES.blockMinutes;

export const UNITS: readonly Unit[] = ['lb', 'kg'];

export type ProfileSettings = {
  /** False until the profile row has synced to this phone; changes are not saved before that. */
  synced: boolean;
  displayName: string;
  unit: Unit;
  /** Default focus block length, 10–50 minutes. */
  blockMinutes: number;
  /** presets.id, or null (the app then uses Full body). */
  defaultPresetId: string | null;
  /** equipment_setups.id, or null (the app then uses the first setup). */
  defaultSetupId: string | null;
};

/** What the app uses before the profile has synced: the column defaults of public.profiles. */
export const DEFAULT_PROFILE: ProfileSettings = {
  synced: false,
  displayName: '',
  unit: 'lb',
  blockMinutes: BLOCK_MINUTES.default,
  defaultPresetId: null,
  defaultSetupId: null,
};

/** True for a whole number of minutes the app offers for a focus block. */
export function isValidBlockMinutes(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= BLOCK_MINUTES.min && value <= BLOCK_MINUTES.max
  );
}

function nonEmptyId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A profiles row (or none yet) as settings; anything out of range falls back to its default. */
export function profileFromRow(row: Partial<ProfileRow> | null | undefined): ProfileSettings {
  if (!row) return DEFAULT_PROFILE;
  return {
    synced: true,
    displayName: typeof row.display_name === 'string' ? row.display_name : '',
    unit: row.unit_pref === 'kg' ? 'kg' : 'lb',
    blockMinutes: isValidBlockMinutes(row.default_block_minutes) ? row.default_block_minutes : BLOCK_MINUTES.default,
    defaultPresetId: nonEmptyId(row.default_preset_id),
    defaultSetupId: nonEmptyId(row.default_setup_id),
  };
}

/** The settings a screen may change. Each key that is present is written; null clears a default. */
export type ProfilePatch = {
  unit?: Unit;
  blockMinutes?: number;
  defaultPresetId?: string | null;
  defaultSetupId?: string | null;
};

/**
 * The UPDATE for a patch: `UPDATE profiles SET <columns>, updated_at = ? WHERE id = ?`. Values the
 * CHECK constraints would refuse are refused here (RangeError), so a bad write never reaches the
 * upload queue. Throws when the patch is empty.
 */
export function profileUpdate(userId: string, patch: ProfilePatch, nowMs: number): { sql: string; params: unknown[] } {
  const columns: string[] = [];
  const params: unknown[] = [];
  if (patch.unit !== undefined) {
    if (!UNITS.includes(patch.unit)) throw new RangeError(`unit_pref must be lb or kg, got ${String(patch.unit)}`);
    columns.push('unit_pref');
    params.push(patch.unit);
  }
  if (patch.blockMinutes !== undefined) {
    if (!isValidBlockMinutes(patch.blockMinutes)) {
      throw new RangeError(
        `default_block_minutes must be a whole number from ${BLOCK_MINUTES.min} to ${BLOCK_MINUTES.max}, got ${patch.blockMinutes}`,
      );
    }
    columns.push('default_block_minutes');
    params.push(patch.blockMinutes);
  }
  if (patch.defaultPresetId !== undefined) {
    columns.push('default_preset_id');
    params.push(nonEmptyId(patch.defaultPresetId));
  }
  if (patch.defaultSetupId !== undefined) {
    columns.push('default_setup_id');
    params.push(nonEmptyId(patch.defaultSetupId));
  }
  if (columns.length === 0) throw new RangeError('Nothing to update');
  const updatedAt = isoTimestamp(nowMs);
  const assignments = [...columns, 'updated_at'].map((column) => `${column} = ?`).join(', ');
  return {
    sql: `UPDATE ${TABLE.profiles} SET ${assignments} WHERE id = ?`,
    params: [...params, updatedAt, userId],
  };
}

/** "25 min" */
export function formatMinutes(minutes: number): string {
  return `${minutes} min`;
}

/** Plain-word unit names for screen readers and settings. */
export const UNIT_LABELS: Readonly<Record<Unit, string>> = { lb: 'Pounds (lb)', kg: 'Kilograms (kg)' };
