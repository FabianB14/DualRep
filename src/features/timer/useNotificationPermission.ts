import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import {
  getNotificationPermission,
  requestNotificationPermission,
  type NotificationPermission,
} from './notifications';

export type NotificationPermissionState = {
  /** null until read. */
  permission: NotificationPermission | null;
  /** Asks (shows the system prompt when Android still allows it) and keeps the answer. */
  request(): Promise<NotificationPermission>;
};

/**
 * The block-end alert permission, for the cycle screen and Settings. It is read on mount and again
 * whenever the app comes back to the foreground (the user may have changed it in system settings).
 * The cycle screen asks for it only when a first block starts (docs/ANDROID.md 1.2: in context, after
 * a one-line reason); Settings offers to ask again. A denied permission just means no alert, and the
 * screens say so quietly.
 */
export function useNotificationPermission(): NotificationPermissionState {
  const [permission, setPermission] = useState<NotificationPermission | null>(null);

  useEffect(() => {
    let active = true;
    const read = () => {
      void getNotificationPermission().then((value) => {
        if (active) setPermission(value);
      });
    };
    read();
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') read();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  const request = useCallback(async () => {
    const value = await requestNotificationPermission();
    setPermission(value);
    return value;
  }, []);

  return { permission, request };
}
