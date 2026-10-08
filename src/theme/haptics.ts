import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * Haptics by intent, so screens say what happened ("success") rather than which motor pattern to
 * play. Feedback is short and sparing: a light tick for presses, distinct patterns for outcomes.
 */
export type HapticIntent = 'tap' | 'select' | 'success' | 'warning' | 'error' | 'handoff';

/**
 * Android uses View.performHapticFeedback (expo-haptics' performAndroidHapticsAsync): it needs no
 * VIBRATE permission, matches system haptics, and respects the user's "touch feedback" setting.
 * Some constants only exist on newer Android (CONFIRM/REJECT: API 30, SEGMENT_TICK: API 34) and reject
 * on older devices, so each intent has a fallback that exists on every API level.
 */
const ANDROID: Record<HapticIntent, [Haptics.AndroidHaptics, Haptics.AndroidHaptics]> = {
  tap: [Haptics.AndroidHaptics.Virtual_Key, Haptics.AndroidHaptics.Virtual_Key],
  select: [Haptics.AndroidHaptics.Segment_Tick, Haptics.AndroidHaptics.Clock_Tick],
  success: [Haptics.AndroidHaptics.Confirm, Haptics.AndroidHaptics.Context_Click],
  warning: [Haptics.AndroidHaptics.Reject, Haptics.AndroidHaptics.Long_Press],
  error: [Haptics.AndroidHaptics.Reject, Haptics.AndroidHaptics.Long_Press],
  handoff: [Haptics.AndroidHaptics.Gesture_End, Haptics.AndroidHaptics.Long_Press],
};

const IOS: Record<HapticIntent, () => Promise<void>> = {
  tap: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  select: () => Haptics.selectionAsync(),
  success: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  warning: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  error: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
  handoff: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
};

/** Fire-and-forget: haptics are a nicety and must never surface an error or block the UI. */
export function haptic(intent: HapticIntent): void {
  if (Platform.OS === 'android') {
    const [preferred, fallback] = ANDROID[intent];
    Haptics.performAndroidHapticsAsync(preferred)
      .catch(() => Haptics.performAndroidHapticsAsync(fallback))
      .catch(() => undefined);
    return;
  }
  if (Platform.OS === 'ios') {
    IOS[intent]().catch(() => undefined);
  }
}
