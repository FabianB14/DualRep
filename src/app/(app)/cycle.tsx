import { useLocalSearchParams } from 'expo-router';

import { CycleScreen } from '@/features/cycle/ui/CycleScreen';

/**
 * The cycle: focus timer → move block → return (src/features/cycle/ui). `?mode=move` ("Just train"
 * on Home) opens the start panel for a workout on its own; it is ignored while a cycle runs, and the
 * screen then shows that cycle. Block-end notifications open this route.
 */
export default function CycleRoute() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  return <CycleScreen mode={mode === 'move' ? 'move' : 'study'} />;
}
