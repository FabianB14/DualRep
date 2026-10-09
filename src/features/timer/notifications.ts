/**
 * Local notifications for the focus timer (docs/ANDROID.md 1.1–1.2, DECISIONS.md D8).
 *
 * The timer keeps time from the clock (timerMath.ts); this module only alerts. When a focus block
 * starts, a notification is scheduled for its end on the high-importance `timers-v1` channel, so the
 * phone rings even with the screen off and the app killed. Nothing runs in the background meanwhile.
 *
 * Rules:
 * - Nothing here throws. A denied permission, a missing native module or an OS error just means no
 *   alert: the on-screen timer still works (ANDROID.md 1.2: "the app must still work when denied").
 * - While a cycle screen is on screen (registerVisibleTimer), the block-end alert is not shown or
 *   played in the foreground: the screen hands off itself, with a haptic. When the app is open on
 *   another screen, the alert is shown as usual, so a block never ends unnoticed.
 * - Channel ids are versioned (`timers-v1`): once a channel exists, the user owns its settings and the
 *   app cannot change them, so a different sound or importance later needs a new id.
 * - A notification carries `data.url`, the screen to open when it is tapped (useNotificationRouting).
 *
 * The D8 measurement (the timer-check screen): scheduleAlertTest schedules a test alert and keeps its
 * due time in local_state; readAlertTestResult compares it with the time Android actually posted it
 * (each presented notification's `date`). Android removes a tapped notification from the shade by
 * default, and the screen can only read the shade once the app is back, so the test alert is posted
 * with autoDismiss off (a tap leaves it there until its time has been saved), and a tap on it also
 * saves its posting time straight from the tap (recordAlertTestFired, from useNotificationRouting).
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { readLocalState, writeLocalState } from '@/features/cycle/localState';

export const TIMER_CHANNEL_ID = 'timers-v1';

/** The screen a block-end alert opens. */
export const CYCLE_URL = '/cycle';

/** The screen the timer-check alert opens. */
export const TIMER_CHECK_URL = '/timer-check';

/** `data.kind` of the notifications this module schedules. */
export const NOTIFICATION_KIND = { blockEnd: 'block-end', alertTest: 'alert-test' } as const;

/** local_state key of the timer-check measurement. */
export const ALERT_TEST_STATE_KEY = 'alert-test';

export const TIMER_CHANNEL = {
  name: 'Block timers',
  description: 'Tells you when a focus block ends.',
  importance: Notifications.AndroidImportance.HIGH,
  vibrationPattern: [0, 300, 200, 300],
  enableVibrate: true,
  lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  sound: 'default',
} satisfies Notifications.NotificationChannelInput;

export type NotificationPermission = 'granted' | 'denied' | 'undetermined';

let configured: Promise<void> | null = null;
let visibleTimers = 0;

/**
 * Call once at startup (more calls do nothing): sets how notifications behave while the app is open
 * and creates the timers channel on Android. Android 13+ only shows the permission prompt once the app
 * has a channel, so the permission functions below call this first too.
 */
export function configureNotifications(): Promise<void> {
  if (!configured) configured = setUp();
  return configured;
}

async function setUp(): Promise<void> {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const show = shouldShowInForeground(notification.request.content.data);
        return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
      },
    });
  } catch {
    // No native module (e.g. a test or web build): there is nothing to configure.
  }
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync(TIMER_CHANNEL_ID, TIMER_CHANNEL);
  } catch {
    // Without the channel, alerts fall back to the default channel or are not shown; the timer still works.
  }
}

/**
 * Whether a notification that arrives while the app is open is shown. A block-end alert is not
 * while a timer screen is visible (it handles the end itself); everything else is.
 */
export function shouldShowInForeground(data: Record<string, unknown> | undefined): boolean {
  return !(data?.kind === NOTIFICATION_KIND.blockEnd && visibleTimers > 0);
}

/**
 * Marks a timer screen as visible until the returned function is called. While at least one is,
 * block-end alerts arriving in the foreground stay silent.
 */
export function registerVisibleTimer(): () => void {
  visibleTimers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    visibleTimers = Math.max(0, visibleTimers - 1);
  };
}

function toPermission(status: Notifications.NotificationPermissionsStatus): NotificationPermission {
  const provisional = status.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  if (status.granted || provisional) return 'granted';
  return status.status === 'denied' ? 'denied' : 'undetermined';
}

/** Whether the app may post notifications. Never asks; 'undetermined' when it cannot tell. */
export async function getNotificationPermission(): Promise<NotificationPermission> {
  try {
    return toPermission(await Notifications.getPermissionsAsync());
  } catch {
    return 'undetermined';
  }
}

/**
 * Asks for permission to post notifications (shows the system prompt when Android still allows
 * asking). Show a one-line reason first. 'denied' when it could not be asked.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  try {
    await configureNotifications();
    const current = await Notifications.getPermissionsAsync();
    if (toPermission(current) === 'granted') return 'granted';
    return toPermission(await Notifications.requestPermissionsAsync());
  } catch {
    return 'denied';
  }
}

export type AlertContent = {
  title: string;
  body: string;
  /**
   * Our own id for the notification. Scheduling again with the same id replaces the earlier one, so
   * a retried or repeated call never leaves two alerts behind.
   */
  identifier?: string;
};

async function scheduleAt(
  atMs: number,
  content: AlertContent,
  data: Record<string, unknown>,
  nowMs: number,
  options: { keepWhenTapped?: boolean } = {},
): Promise<string | null> {
  if (!Number.isFinite(atMs) || atMs <= nowMs) return null;
  try {
    if ((await getNotificationPermission()) !== 'granted') return null;
    await configureNotifications();
    // autoDismiss false: Android leaves the notification in the shade when it is tapped.
    const keep = options.keepWhenTapped ? { autoDismiss: false } : {};
    return await Notifications.scheduleNotificationAsync({
      ...(content.identifier ? { identifier: content.identifier } : {}),
      content: { title: content.title, body: content.body, data, sound: 'default', ...keep },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: atMs, channelId: TIMER_CHANNEL_ID },
    });
  } catch {
    return null;
  }
}

/**
 * Schedules the end-of-block alert for `endsAtMs`. Returns the notification id, or null when no alert
 * was scheduled (permission not granted, the time has passed, or the OS refused). Never throws.
 */
export function scheduleBlockEnd(endsAtMs: number, content: AlertContent, nowMs = Date.now()): Promise<string | null> {
  return scheduleAt(endsAtMs, content, { url: CYCLE_URL, kind: NOTIFICATION_KIND.blockEnd }, nowMs);
}

/**
 * Cancels a scheduled alert and removes it from the notification shade if it has already been shown
 * (the block was paused, ended early, or the app already handed off). Unknown ids are fine. Never throws.
 */
export async function cancelScheduled(id: string | null | undefined): Promise<void> {
  if (!id) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(id);
  } catch {
    // Nothing scheduled under this id, or no native module.
  }
  try {
    await Notifications.dismissNotificationAsync(id);
  } catch {
    // Not in the shade.
  }
}

/**
 * Withdraws every alert DualRep has scheduled and clears the ones in the shade (a block-end alert, a
 * timer-check test). For sign-out: nothing of the signed-out account may ring afterwards, and a tap
 * on a leftover alert would open a screen that no longer exists. Never throws.
 */
export async function cancelAllAlerts(): Promise<void> {
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch {
    // Nothing scheduled, or no native module.
  }
  try {
    await Notifications.dismissAllNotificationsAsync();
  } catch {
    // Nothing in the shade.
  }
}

/** The timer-check measurement, as kept in local_state. Times are epoch ms. */
export type AlertTest = {
  id: string;
  minutes: number;
  scheduledAt: number;
  /** When the alert was due. */
  dueAt: number;
  /** When Android posted it, once seen in the shade. */
  firedAt: number | null;
};

export type AlertTestResult =
  /** No test has been run. */
  | { status: 'none' }
  /** Not due yet. */
  | { status: 'waiting'; test: AlertTest }
  /** Due, but Android has not posted it yet (it is still scheduled): Doze is delaying it. */
  | { status: 'delayed'; test: AlertTest; lateByMs: number }
  /** It fired, but it was cleared from the shade (swiped away) before its time was read. */
  | { status: 'missed'; test: AlertTest }
  | { status: 'fired'; test: AlertTest; firedAt: number; delayMs: number };

/** Notification dates are epoch ms on Android; seconds are converted (some platforms report those). */
function epochMs(date: number): number {
  return date < 1e12 ? date * 1000 : date;
}

/**
 * Schedules a test alert in `minutes` (at least 1) and remembers when it is due, replacing any earlier
 * test. The alert stays in the shade when tapped (see the header). Returns null when no alert could be
 * scheduled (usually: notifications not allowed).
 */
export async function scheduleAlertTest(minutes: number, nowMs = Date.now()): Promise<AlertTest | null> {
  const wait = Math.max(1, Number.isFinite(minutes) ? minutes : 1);
  const previous = await readLocalState<AlertTest>(ALERT_TEST_STATE_KEY).catch(() => null);
  if (previous?.id) await cancelScheduled(previous.id);
  const dueAt = nowMs + Math.round(wait * 60_000);
  const id = await scheduleAt(
    dueAt,
    {
      identifier: `alert-test-${nowMs}`,
      title: 'Timer check',
      body: 'This is the test alert. Open DualRep to see how late it came.',
    },
    { url: TIMER_CHECK_URL, kind: NOTIFICATION_KIND.alertTest },
    nowMs,
    { keepWhenTapped: true },
  );
  if (!id) return null;
  const test: AlertTest = { id, minutes: wait, scheduledAt: nowMs, dueAt, firedAt: null };
  try {
    await writeLocalState(ALERT_TEST_STATE_KEY, test);
  } catch {
    await cancelScheduled(id);
    return null;
  }
  return test;
}

/**
 * Saves when the current test alert was posted, from a tap on it (NotificationResponse.notification
 * .date), so the measurement holds even if the alert is no longer in the shade when the screen reads
 * it. Only for the current test, and only once. Never throws.
 */
export async function recordAlertTestFired(identifier: string, postedAt: number): Promise<void> {
  if (!Number.isFinite(postedAt) || postedAt <= 0) return;
  try {
    const test = await readLocalState<AlertTest>(ALERT_TEST_STATE_KEY);
    if (!test || test.id !== identifier || typeof test.firedAt === 'number') return;
    await writeLocalState(ALERT_TEST_STATE_KEY, { ...test, firedAt: epochMs(postedAt) });
    await Notifications.dismissNotificationAsync(identifier).catch(() => undefined);
  } catch {
    // Not saved: the screen still reads it from the shade, where the tapped test alert stays.
  }
}

/**
 * The timer-check result: how late the test alert was posted compared with when it was due. The
 * posted time is read from the shade (or was saved when the alert was tapped); once read it is saved,
 * the alert is cleared from the shade, and later reads return the saved time.
 */
export async function readAlertTestResult(nowMs = Date.now()): Promise<AlertTestResult> {
  let test: AlertTest | null;
  try {
    test = await readLocalState<AlertTest>(ALERT_TEST_STATE_KEY);
  } catch {
    return { status: 'none' };
  }
  if (!test || typeof test.id !== 'string' || !Number.isFinite(test.dueAt)) return { status: 'none' };
  if (typeof test.firedAt === 'number') {
    return { status: 'fired', test, firedAt: test.firedAt, delayMs: test.firedAt - test.dueAt };
  }

  const presented = await Notifications.getPresentedNotificationsAsync().catch(() => [] as Notifications.Notification[]);
  const shown = presented.find((notification) => notification.request.identifier === test.id);
  if (shown) {
    const firedAt = epochMs(shown.date);
    const saved: AlertTest = { ...test, firedAt };
    const kept = await writeLocalState(ALERT_TEST_STATE_KEY, saved).then(
      () => true,
      () => false,
    );
    // A tap left it in the shade (autoDismiss off); now that its time is saved it can go.
    if (kept) await Notifications.dismissNotificationAsync(test.id).catch(() => undefined);
    return { status: 'fired', test: saved, firedAt, delayMs: firedAt - test.dueAt };
  }

  if (nowMs < test.dueAt) return { status: 'waiting', test };
  const scheduled = await Notifications.getAllScheduledNotificationsAsync().catch(() => null);
  const stillScheduled = scheduled?.some((request) => request.identifier === test.id) ?? true;
  return stillScheduled ? { status: 'delayed', test, lateByMs: nowMs - test.dueAt } : { status: 'missed', test };
}

/** Test hook: forget the one-time setup and visible timers. */
export function resetNotificationsForTests(): void {
  configured = null;
  visibleTimers = 0;
}
