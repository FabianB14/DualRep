/**
 * The plan form's working copy (pure): what "New plan" and "Plan settings" edit before saving with
 * studyRepo.createPlan / updatePlan. The limits match studyRepo.STUDY_LIMITS (planDraft.test.ts checks
 * that they stay equal), so a draft that passes here is never refused by the repo.
 */
import { localDateMs, localDateString, type PlanScopeValue } from './studyText';

export const PLAN_TITLE_MAX = 200;
export const PLAN_GOAL_MAX = 1000;

export type PlanDraft = {
  title: string;
  scope: PlanScopeValue;
  goal: string;
  /** 'YYYY-MM-DD', or '' for no date. Typed by hand or set by a quick choice. */
  targetDate: string;
};

/** A new plan: a growing course is the common case (a term's lectures, added as they come). */
export const EMPTY_PLAN_DRAFT: PlanDraft = Object.freeze({ title: '', scope: 'cumulative', goal: '', targetDate: '' }) as PlanDraft;

export function planDraftFrom(plan: { title: string; scope: PlanScopeValue; goal: string; targetDate: string | null }): PlanDraft {
  return { title: plan.title, scope: plan.scope, goal: plan.goal, targetDate: plan.targetDate ?? '' };
}

export type PlanDraftErrors = { title?: string; goal?: string; targetDate?: string };

/** What stops saving, per field (none = the draft can be saved). */
export function planDraftErrors(draft: PlanDraft): PlanDraftErrors {
  const errors: PlanDraftErrors = {};
  const title = draft.title.trim();
  if (title === '') errors.title = 'Give the plan a name, e.g. the course or the exam.';
  else if (title.length > PLAN_TITLE_MAX) errors.title = `Use at most ${PLAN_TITLE_MAX} characters.`;
  if (draft.goal.trim().length > PLAN_GOAL_MAX) errors.goal = `Use at most ${PLAN_GOAL_MAX} characters.`;
  const date = draft.targetDate.trim();
  if (date !== '' && localDateMs(date) === null) errors.targetDate = 'Type the date as year-month-day, e.g. 2026-12-14.';
  return errors;
}

export function hasPlanDraftErrors(errors: PlanDraftErrors): boolean {
  return Boolean(errors.title || errors.goal || errors.targetDate);
}

/** The values to save: trimmed, and no date as null. */
export function planDraftValues(draft: PlanDraft): { title: string; scope: PlanScopeValue; goal: string; targetDate: string | null } {
  const date = draft.targetDate.trim();
  return { title: draft.title.trim(), scope: draft.scope, goal: draft.goal.trim(), targetDate: date === '' ? null : date };
}

/** Quick choices for the exam or deadline, so most people never type a date. */
export const TARGET_DATE_CHOICES: readonly { days: number; label: string }[] = [
  { days: 7, label: 'In 1 week' },
  { days: 14, label: 'In 2 weeks' },
  { days: 28, label: 'In 4 weeks' },
  { days: 56, label: 'In 8 weeks' },
];

/** The local date `days` calendar days after `nowMs`, 'YYYY-MM-DD'. */
export function dateInDays(days: number, nowMs: number): string {
  const now = new Date(nowMs);
  // Noon, so adding days never lands on the wrong date across a daylight-saving change.
  return localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 12).getTime());
}
