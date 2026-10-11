/**
 * The outline review's working copy (pure). The study builder proposes topics as drafts
 * (topics.status = 'draft'); the person keeps or cuts each one, renames it and puts them in order,
 * then "Save and make cards" sends the whole decision to the study function (approve_outline) in one
 * call. Until then every change is only on this screen, so nothing is lost by leaving or undone by a
 * sync, and every change can be taken back.
 *
 * Reordering is by Move up / Move down (buttons and screen-reader actions), never drag-only.
 */
import type { OutlineDecision } from '@/features/study/studyApi';

/** = STUDY_API_LIMITS.maxTopicTitleChars (the study function's limit for a topic title). */
export const OUTLINE_TITLE_MAX = 120;

export type OutlineItem = {
  id: string;
  /** What the person typed (or the proposed title, untouched). */
  title: string;
  /** The proposed title, to tell whether it was renamed. */
  proposed: string;
  keep: boolean;
};

/**
 * The working copy for the draft topics `drafts` (in the order proposed). Edits already made in
 * `previous` are kept: a topic still there keeps its place, title and keep/cut; a draft that arrived
 * since (a second outline synced in) is added at the end; one that left (approved on another phone)
 * is dropped.
 */
export function outlineItemsFrom(drafts: readonly { id: string; title: string }[], previous: readonly OutlineItem[] = []): OutlineItem[] {
  const byId = new Map(drafts.map((draft) => [draft.id, draft]));
  const kept = previous
    .filter((item) => byId.has(item.id))
    .map((item) => ({ ...item, proposed: byId.get(item.id)?.title ?? item.proposed }));
  const known = new Set(kept.map((item) => item.id));
  const added = drafts
    .filter((draft) => !known.has(draft.id))
    .map((draft) => ({ id: draft.id, title: draft.title, proposed: draft.title, keep: true }));
  return [...kept, ...added];
}

/** The list with the item at `index` moved by `delta` places (clamped); the same list when it can't move. */
export function moveOutlineItem(items: readonly OutlineItem[], index: number, delta: number): OutlineItem[] {
  const to = Math.max(0, Math.min(items.length - 1, index + delta));
  if (index < 0 || index >= items.length || to === index) return [...items];
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item);
  return next;
}

export function setOutlineKeep(items: readonly OutlineItem[], id: string, keep: boolean): OutlineItem[] {
  return items.map((item) => (item.id === id ? { ...item, keep } : item));
}

export function renameOutlineItem(items: readonly OutlineItem[], id: string, title: string): OutlineItem[] {
  return items.map((item) => (item.id === id ? { ...item, title } : item));
}

/** Problems that stop the save, by topic id: a kept topic needs a name of at most 120 characters. */
export function outlineErrors(items: readonly OutlineItem[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const item of items) {
    if (!item.keep) continue;
    const title = item.title.trim();
    if (title === '') errors[item.id] = 'Give this topic a name, or cut it.';
    else if (title.length > OUTLINE_TITLE_MAX) errors[item.id] = `Use at most ${OUTLINE_TITLE_MAX} characters.`;
  }
  return errors;
}

/**
 * The approve_outline `topics` list: every draft in the chosen order, kept or cut, with the new title
 * only where it was renamed (trimmed). Cut topics are listed too (keep: false) so the decision is
 * explicit rather than implied by leaving them out.
 */
export function outlineDecisions(items: readonly OutlineItem[]): OutlineDecision[] {
  return items.map((item) => {
    const title = item.title.trim();
    const renamed = item.keep && title !== '' && title !== item.proposed.trim();
    return renamed ? { id: item.id, title, keep: item.keep } : { id: item.id, keep: item.keep };
  });
}

/** "6 topics kept, 2 cut", for the line above the save button. */
export function outlineSummary(items: readonly OutlineItem[]): string {
  const kept = items.filter((item) => item.keep).length;
  const cut = items.length - kept;
  const keptText = `${kept} ${kept === 1 ? 'topic' : 'topics'} kept`;
  return cut > 0 ? `${keptText}, ${cut} cut` : keptText;
}

/** True when anything differs from the proposal (order, a name, a cut). */
export function outlineChanged(items: readonly OutlineItem[], drafts: readonly { id: string }[]): boolean {
  if (items.some((item) => !item.keep || item.title.trim() !== item.proposed.trim())) return true;
  return items.some((item, index) => drafts[index]?.id !== item.id);
}
