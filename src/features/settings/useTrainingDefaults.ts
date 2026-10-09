import { useMemo } from 'react';

import { resolvePreset, type Preset } from '@/features/presets/presets';
import { usePresets } from '@/features/presets/usePresets';
import { resolveSetup } from '@/features/setups/setups';
import { useSetups } from '@/features/setups/useSetups';
import type { Setup, Unit } from '@/features/training/types';

import type { ProfileSettings } from './profile';
import { useProfile } from './useProfile';

export type TrainingDefaults = {
  profile: ProfileSettings;
  /** Default focus block length, 10–50 minutes. */
  blockMinutes: number;
  unit: Unit;
  /** The default preset, else Full body (always set, also before the first sync). */
  preset: Preset;
  /** The default setup, else the first one, else null (the user has made none yet). */
  setup: Setup | null;
  isLoading: boolean;
};

/**
 * What a new cycle starts with, all read from the local database: block length, unit, preset and
 * setup, each with its fallback (see resolvePreset / resolveSetup). Home shows these, and the cycle
 * screen's start panel can start from them. Must be used under `PowerSyncContext.Provider` and
 * `AuthProvider`.
 */
export function useTrainingDefaults(): TrainingDefaults {
  const { profile, isLoading: profileLoading } = useProfile();
  const presets = usePresets();
  const { setups, isLoading: setupsLoading } = useSetups();
  return useMemo(
    () => ({
      profile,
      blockMinutes: profile.blockMinutes,
      unit: profile.unit,
      preset: resolvePreset(presets, profile.defaultPresetId),
      setup: resolveSetup(setups, profile.defaultSetupId),
      isLoading: profileLoading || presets.isLoading || setupsLoading,
    }),
    [profile, presets, setups, profileLoading, setupsLoading],
  );
}
