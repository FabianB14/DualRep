/**
 * The study screens' words: labels and short phrases built from synced rows (pure, so each wording
 * rule is unit-tested). Plain English, no jargon: "Due in 3 days", "Learn this first", "12 due · 30 new".
 *
 * Nothing here imports the database or a native module, so any screen or test can use it.
 */
import type { AddMaterialProgress } from '@/features/study/upload';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** "1 card", "3 cards"; `plural` defaults to the singular + "s". */
export function countText(n: number, singular: string, plural: string = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

// ---- Plans --------------------------------------------------------------------------------------

export type PlanScopeValue = 'single' | 'cumulative';

/** The two kinds of plan, in plain words (study_plans.scope). */
export const SCOPE_TEXT: Record<PlanScopeValue, { label: string; detail: string }> = {
  single: {
    label: 'One source',
    detail: 'A book, a handout or one set of slides.',
  },
  cumulative: {
    label: 'Growing course',
    detail: 'Add each lecture as it comes; reviews mix everything so far.',
  },
};

/** "12 due · 30 new · 2 sources", or "No cards yet · 1 source". */
export function planCountsText(plan: { dueCount: number; newCount: number; cardCount: number; sourceCount: number }): string {
  const parts: string[] = [];
  if (plan.cardCount === 0) parts.push('No cards yet');
  else {
    if (plan.dueCount > 0) parts.push(`${plan.dueCount} due`);
    if (plan.newCount > 0) parts.push(`${plan.newCount} new`);
    if (plan.dueCount === 0 && plan.newCount === 0) parts.push('Nothing due');
  }
  parts.push(plan.sourceCount === 0 ? 'No material yet' : countText(plan.sourceCount, 'source'));
  return parts.join(' · ');
}

/** Local midnight of a 'YYYY-MM-DD' date (epoch ms), or null when it is not one. */
export function localDateMs(date: string | null | undefined): number | null {
  const match = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const value = new Date(year, month - 1, day);
  if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day) return null;
  return value.getTime();
}

/** The local calendar date of an instant, 'YYYY-MM-DD'. */
export function localDateString(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Whole calendar days from today (local) to `date`; negative when it has passed; null when not a date. */
export function daysUntil(date: string | null | undefined, nowMs: number): number | null {
  const target = localDateMs(date);
  if (target === null) return null;
  const now = new Date(nowMs);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // Rounded: a day that has a daylight-saving change is 23 or 25 hours long.
  return Math.round((target - today) / DAY_MS);
}

/** "Mon 14 Dec" in the phone's language. */
export function shortDate(date: string): string {
  const ms = localDateMs(date);
  if (ms === null) return date;
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** "Mon 14 Dec, in 66 days" / "…, tomorrow" / "…, today" / "…, 3 days ago". */
export function targetDateText(date: string, nowMs: number): string {
  const days = daysUntil(date, nowMs);
  const when = shortDate(date);
  if (days === null) return when;
  if (days === 0) return `${when}, today`;
  if (days === 1) return `${when}, tomorrow`;
  if (days > 1) return `${when}, in ${days} days`;
  if (days === -1) return `${when}, yesterday`;
  return `${when}, ${-days} days ago`;
}

// ---- Sources ------------------------------------------------------------------------------------

export const SOURCE_KIND_LABELS: Record<string, string> = {
  pdf: 'PDF',
  doc: 'Word document',
  notes: 'Photos of notes',
  link: 'Web page',
};

export function sourceKindLabel(kind: string | null | undefined): string {
  return (kind && SOURCE_KIND_LABELS[kind]) || 'Material';
}

/** What the add-material screen says while it works: "Uploading photo 2 of 5 (40%)". */
export function materialProgressText(progress: AddMaterialProgress, kind: 'document' | 'notes' | 'link'): string {
  const thing = kind === 'notes' ? 'photo' : 'file';
  const many = progress.total > 1;
  const which = many ? ` ${thing} ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : '';
  switch (progress.phase) {
    case 'preparing':
      return kind === 'notes' ? `Getting${which || ' the photo'} ready…` : 'Getting the file ready…';
    case 'uploading': {
      const percent =
        typeof progress.bytesSent === 'number' && typeof progress.totalBytes === 'number' && progress.totalBytes > 0
          ? ` (${Math.min(100, Math.floor((progress.bytesSent / progress.totalBytes) * 100))}%)`
          : '';
      return `Uploading${which || (kind === 'link' ? '' : ` the ${thing}`)}${percent}…`;
    }
    case 'submitting':
      return 'Starting to read it…';
    case 'done':
      return 'Added.';
  }
}

// ---- Cards --------------------------------------------------------------------------------------

/** When a card comes back, from the user's card state: "New", "Due now", "Due in 3 days", "Paused". */
export function cardStatusText(card: { state: number | null; due: string | null; suspended: boolean }, nowMs: number): string {
  if (card.suspended) return 'Paused';
  if (card.state === null || card.state === 0) return 'New';
  const due = card.due ? Date.parse(card.due) : Number.NaN;
  if (!Number.isFinite(due) || due <= nowMs) return 'Due now';
  const wait = due - nowMs;
  if (wait < HOUR_MS) return `Due in ${countText(Math.max(1, Math.ceil(wait / MINUTE_MS)), 'minute')}`;
  if (wait < DAY_MS) return `Due in ${countText(Math.round(wait / HOUR_MS), 'hour')}`;
  // A day or more away: count calendar days, as people do ("tomorrow" is the next date).
  const days = Math.max(1, daysUntil(localDateString(due), nowMs) ?? 1);
  if (days === 1) return 'Due tomorrow';
  if (days < 60) return `Due in ${days} days`;
  return `Due in ${countText(Math.round(days / 30), 'month')}`;
}

export const CARD_TYPE_LABELS: Record<string, string> = {
  basic: 'Question',
  cloze: 'Fill the gap',
  why: 'Explain why',
  write_from_memory: 'Write from memory',
};

export function cardTypeLabel(type: string | null | undefined): string {
  return (type && CARD_TYPE_LABELS[type]) || 'Question';
}

// ---- Links between cards ------------------------------------------------------------------------

/**
 * A link's relation as seen from the card in the middle. A link reads "from-card <relation>
 * to-card": a prerequisite link means the from-card comes first. So from the to-card's side the
 * other card is "Learn this first", and from the from-card's side it "Builds on this".
 */
export function relationLabel(relation: string | null | undefined, centerIsFrom: boolean): string {
  switch (relation) {
    case 'prerequisite':
      return centerIsFrom ? 'Builds on this' : 'Learn this first';
    case 'why':
      return 'Reason';
    case 'analogy':
      return 'Similar idea';
    case 'contrast':
      return 'Contrast';
    default:
      return 'Related';
  }
}

/**
 * The relations a person can pick when linking another card to the card in the middle, in plain
 * words, as the other card is to the middle one. "Learn this first" is stored as a prerequisite link
 * from the other card to the middle one; every other choice links from the middle card.
 */
export const RELATION_CHOICES: readonly { value: 'related' | 'prerequisite' | 'why' | 'analogy' | 'contrast'; label: string }[] = [
  { value: 'related', label: 'Related' },
  { value: 'prerequisite', label: 'Learn this first' },
  { value: 'why', label: 'Reason' },
  { value: 'analogy', label: 'Similar idea' },
  { value: 'contrast', label: 'Contrast' },
];
