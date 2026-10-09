/**
 * The daily "cards to review" reminder (expo-notifications 57; Phase 2, "The app").
 *
 * Local notifications at the time the user picked (Settings → Daily review reminder), on their own
 * channel `reviews-v1` (versioned like `timers-v1`: once a channel exists, the user owns its settings):
 * the reminder (id `reviews-due`) and, when it is a one-time one, up to 13 follow-ups
 * (`reviews-due-1` … `-13`, see below). Every reschedule withdraws all of them first.
 * Nothing runs in the background: the reminder is (re)scheduled when the app starts, comes to the
 * foreground, ends a focus block, receives a sync that changed card states, and when the setting
 * changes. A card counts on its day (as in the queue: a review is due on its day, not at its minute,
 * so a card last answered at 09:02 is in the 09:00 reminder the day it comes back). Each time:
 *   - cards due on the day of the next reminder → a DAILY trigger at hh:mm with "N cards are due". The
 *     text is fixed when scheduled; if the app is not opened, due counts only grow, so N stays a true
 *     lower bound (answers on another phone could make it an overstatement, which is minor);
 *   - none due that day → a reminder at hh:mm on the day the first card falls due and on each of the
 *     13 days after it (one-time triggers), or nothing at all when no card ever will. No nagging on
 *     days with nothing to do, and an ignored reminder is not the last one: cards that are not
 *     answered stay due, so the following days remind again until the app runs and reschedules.
 *     (A single one-time trigger would leave a user who dismissed it with no reminder at all while
 *     reviews piled up, which is exactly when one is needed.)
 * Android computes the next local hh:mm itself, keeps the alarm across reboots, and uses an exact
 * alarm only when allowed (an inexact one is fine for a daily nudge), so no new permission is needed.
 *
 * Nothing here throws: a denied permission or a missing native module just means no reminder.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { getNotificationPermission } from '@/features/timer/notifications';

import { endOfLocalDay } from './queue';
import { countDueCards, firstDueAfter } from './studyRepo';
import type { ReminderPref } from './studyPrefs';

export const REVIEWS_CHANNEL_ID = 'reviews-v1';

export const REVIEWS_CHANNEL = {
  name: 'Review reminders',
  description: 'Once a day, when cards are due.',
  importance: Notifications.AndroidImportance.DEFAULT,
  // The lock screen shows the count only; a card's text is never in a notification.
  lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  sound: 'default',
} satisfies Notifications.NotificationChannelInput;

/** Our id of the reminder: scheduling again replaces it. */
export const REVIEW_REMINDER_ID = 'reviews-due';
/** One-time reminders on the days after the first due day (see the header). */
export const FOLLOW_UP_DAYS = 13;
const followUpId = (day: number) => `${REVIEW_REMINDER_ID}-${day}`;
/** Every id this module schedules under, so a reschedule withdraws all of them. */
export const REVIEW_REMINDER_IDS: readonly string[] = [
  REVIEW_REMINDER_ID,
  ...Array.from({ length: FOLLOW_UP_DAYS }, (_, i) => followUpId(i + 1)),
];
/** `data.kind` of the reminder (useNotificationRouting opens `data.url`, Home). */
export const REVIEW_REMINDER_KIND = 'reviews-due';
export const REVIEW_REMINDER_URL = '/';

export type ReminderOutcome =
  | { status: 'off' }
  | { status: 'no_permission' }
  /** Nothing is due now or later. */
  | { status: 'nothing_due' }
  | { status: 'daily'; at: number; count: number }
  | { status: 'once'; at: number; count: number }
  /** The OS refused (or there is no native module). */
  | { status: 'failed' };

/**
 * The first local `hour:minute` after `afterMs` (or at it, when `inclusive`). Uses the phone's time
 * zone, daylight-saving changes included.
 */
export function nextLocalTime(time: Pick<ReminderPref, 'hour' | 'minute'>, afterMs: number, inclusive = false): number {
  const candidate = new Date(afterMs);
  candidate.setHours(time.hour, time.minute, 0, 0);
  const passed = inclusive ? candidate.getTime() < afterMs : candidate.getTime() <= afterMs;
  if (passed) {
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(time.hour, time.minute, 0, 0);
  }
  return candidate.getTime();
}

/** The reminder's words. */
export function reminderContent(count: number): { title: string; body: string } {
  const n = Math.max(1, Math.floor(count));
  return {
    title: 'Cards to review',
    body: `${n} card${n === 1 ? ' is' : 's are'} due. A 10-minute block clears a lot of them.`,
  };
}

let channelReady: Promise<void> | null = null;

/** Creates the reminder channel on Android, once. */
export function ensureReviewsChannel(): Promise<void> {
  if (Platform.OS !== 'android') return Promise.resolve();
  if (!channelReady) {
    channelReady = Notifications.setNotificationChannelAsync(REVIEWS_CHANNEL_ID, REVIEWS_CHANNEL).then(
      () => undefined,
      () => {
        channelReady = null; // try again next time
      },
    );
  }
  return channelReady;
}

/** Withdraws the scheduled reminders (one already in the shade stays). Never throws. */
export async function cancelReviewReminder(): Promise<void> {
  for (const id of REVIEW_REMINDER_IDS) {
    try {
      await Notifications.cancelScheduledNotificationAsync(id);
    } catch {
      // Nothing scheduled, or no native module.
    }
  }
}

export type ReminderDeps = {
  now?: number;
  countDue?: (userId: string, untilMs: number) => Promise<number>;
  firstDueAfter?: (userId: string, afterMs: number) => Promise<number | null>;
};

/**
 * Replaces the reminder with one that matches the cards due now. Call it on app start, on return to
 * the foreground, after a focus block, after a sync changed card states, and when the setting changes.
 */
export async function rescheduleReviewReminder(
  userId: string | null,
  pref: ReminderPref | null,
  deps: ReminderDeps = {},
): Promise<ReminderOutcome> {
  await cancelReviewReminder();
  if (!userId || !pref?.enabled) return { status: 'off' };
  if ((await getNotificationPermission()) !== 'granted') return { status: 'no_permission' };
  const now = deps.now ?? Date.now();
  const countDue = deps.countDue ?? countDueCards;
  const firstAfter = deps.firstDueAfter ?? firstDueAfter;
  try {
    await ensureReviewsChannel();
    const next = nextLocalTime(pref, now);
    const count = await countDue(userId, endOfLocalDay(next));
    if (count > 0) {
      await Notifications.scheduleNotificationAsync({
        identifier: REVIEW_REMINDER_ID,
        content: { ...reminderContent(count), data: { url: REVIEW_REMINDER_URL, kind: REVIEW_REMINDER_KIND }, sound: 'default' },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DAILY,
          hour: pref.hour,
          minute: pref.minute,
          channelId: REVIEWS_CHANNEL_ID,
        },
      });
      return { status: 'daily', at: next, count };
    }
    const first = await firstAfter(userId, endOfLocalDay(next));
    if (first === null) return { status: 'nothing_due' };
    // hh:mm on the day it falls due (that day's block asks it, whatever its minute).
    const startOfDay = new Date(first);
    startOfDay.setHours(0, 0, 0, 0);
    const at = nextLocalTime(pref, startOfDay.getTime(), true);
    const then = Math.max(1, await countDue(userId, endOfLocalDay(at)));
    const once = (identifier: string, count: number, date: number) =>
      Notifications.scheduleNotificationAsync({
        identifier,
        content: { ...reminderContent(count), data: { url: REVIEW_REMINDER_URL, kind: REVIEW_REMINDER_KIND }, sound: 'default' },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date, channelId: REVIEWS_CHANNEL_ID },
      });
    await once(REVIEW_REMINDER_ID, then, at);
    // The days after it: the same local time (setDate keeps it across a daylight-saving change), with
    // the count due by then (counts only grow while nothing is answered).
    for (let day = 1; day <= FOLLOW_UP_DAYS; day += 1) {
      const date = new Date(at);
      date.setDate(date.getDate() + day);
      const when = date.getTime();
      await once(followUpId(day), Math.max(then, await countDue(userId, endOfLocalDay(when))), when);
    }
    return { status: 'once', at, count: then };
  } catch {
    return { status: 'failed' };
  }
}

/** Test hook: forget the channel set-up. */
export function resetRemindersForTests(): void {
  channelReady = null;
}
