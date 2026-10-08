import * as Notifications from 'expo-notifications';
import { useRootNavigationState, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

/**
 * The in-app screen a tapped notification asks to open (`data.url`), or null. Only app paths are
 * accepted ("/cycle"), never another scheme or a protocol-relative "//host" URL, so a notification can
 * only move the user within DualRep.
 */
export function notificationUrl(response: Notifications.NotificationResponse | null | undefined): string | null {
  const url = response?.notification?.request?.content?.data?.url;
  if (typeof url !== 'string') return null;
  if (!url.startsWith('/') || url.startsWith('//') || /\s/.test(url)) return null;
  return url;
}

function responseKey(response: Notifications.NotificationResponse): string {
  return `${response.notification.request.identifier}:${response.notification.date}`;
}

/**
 * Opens the screen a notification points to when the user taps it: while the app runs (the response
 * listener) and when the tap launched the app (the last response, read once at mount). The route is
 * opened once the root navigator is ready, and the last response is cleared afterwards so that a
 * later remount (e.g. signing in again) does not open it a second time. Mount once, inside the
 * signed-in tree.
 */
export function useNotificationRouting(): void {
  const router = useRouter();
  const navigationState = useRootNavigationState();
  const ready = navigationState?.key != null;
  const latest = useRef({ router, ready });
  /** A tapped notification's screen, waiting for the navigator. */
  const pending = useRef<string | null>(null);

  const openPending = useCallback(() => {
    const url = pending.current;
    if (url === null || !latest.current.ready) return;
    pending.current = null;
    try {
      latest.current.router.navigate(url as Href);
    } catch {
      // The route is not available (e.g. signed out meanwhile): stay where we are.
    }
    try {
      Notifications.clearLastNotificationResponse();
    } catch {
      // Nothing to clear.
    }
  }, []);

  useEffect(() => {
    latest.current = { router, ready };
    openPending();
  }, [router, ready, openPending]);

  useEffect(() => {
    let active = true;
    const seen = new Set<string>();
    const take = (response: Notifications.NotificationResponse | null) => {
      const url = notificationUrl(response);
      if (!response || !url || !active) return;
      const key = responseKey(response);
      if (seen.has(key)) return;
      seen.add(key);
      pending.current = url;
      openPending();
    };

    try {
      take(Notifications.getLastNotificationResponse());
    } catch {
      // No native module: nothing launched the app from a notification.
    }
    let subscription: { remove(): void } | null = null;
    try {
      subscription = Notifications.addNotificationResponseReceivedListener(take);
    } catch {
      subscription = null;
    }
    return () => {
      active = false;
      subscription?.remove();
    };
  }, [openPending]);
}
