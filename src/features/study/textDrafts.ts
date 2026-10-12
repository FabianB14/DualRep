/**
 * Spoken or typed notes that have not been added to their plan yet, kept on this phone.
 *
 * Dictating and typing work offline; adding the notes to a plan needs the internet (the `study`
 * function stores the text and queues the work). So the notes screen saves what is on screen as a
 * draft in `local_state` (never synced or uploaded; cleared on sign-out), one draft per plan, and the
 * plan screen shows "Unsent notes" until it is added. The draft keeps the source id of its first "Add
 * to plan" attempt, so a retry after a lost response is the same submit (already_submitted) and never
 * adds the notes twice; the draft is deleted once the server has them.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';

import { deleteLocalState, readLocalState, readLocalStateByPrefix, useLocalState, writeLocalState } from '@/features/cycle/localState';

import { cleanStudyText, NOTE_MAX_CHARS, STUDY_API_LIMITS } from './studyApi';

export const TEXT_DRAFT_KEY_PREFIX = 'study-text-draft:';

/** A change is on the phone at most this long after it is made. */
export const TEXT_DRAFT_SAVE_MS = 1_000;

export type TextDraft = {
  v: 1;
  planId: string;
  /** Made when the notes are first saved; reused by every "Add to plan" attempt for this draft. */
  sourceId: string;
  /** '' = the default name ("Notes, 12 Oct"). */
  title: string;
  /** What the editor holds (not yet cleaned; may be over the limit while the person edits). */
  text: string;
  /** Epoch ms of the last change. */
  updatedAt: number;
};

export const textDraftKey = (planId: string) => `${TEXT_DRAFT_KEY_PREFIX}${planId}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A stored draft for this plan, or null when there is none or it is not one (a value from elsewhere). */
export function parseTextDraft(value: unknown, planId: string): TextDraft | null {
  if (typeof value !== 'object' || value === null) return null;
  const d = value as Partial<TextDraft>;
  if (d.v !== 1 || d.planId !== planId || typeof d.sourceId !== 'string' || !UUID.test(d.sourceId)) return null;
  if (typeof d.text !== 'string' || typeof d.title !== 'string' || typeof d.updatedAt !== 'number' || !Number.isFinite(d.updatedAt)) return null;
  return {
    v: 1,
    planId,
    sourceId: d.sourceId,
    title: d.title.slice(0, STUDY_API_LIMITS.maxTitleChars),
    text: d.text,
    updatedAt: d.updatedAt,
  };
}

/**
 * The draft to save: the editor's text, cut at twice the limit so a pasted book cannot fill the
 * phone (an over-long draft is kept whole up to there, so the person can shorten it themselves).
 */
export function draftToSave(draft: Omit<TextDraft, 'v'>): TextDraft {
  return { ...draft, v: 1, text: draft.text.slice(0, NOTE_MAX_CHARS * 2) };
}

/** True when the draft holds notes worth keeping (a draft of only spaces is not "unsent notes"). */
export function draftHasText(draft: Pick<TextDraft, 'text'> | null): boolean {
  return draft !== null && cleanStudyText(draft.text) !== '';
}

export async function readTextDraft(planId: string): Promise<TextDraft | null> {
  return parseTextDraft(await readLocalState<unknown>(textDraftKey(planId)), planId);
}

export async function saveTextDraft(draft: Omit<TextDraft, 'v'>): Promise<void> {
  await writeLocalState(textDraftKey(draft.planId), draftToSave(draft));
}

export async function clearTextDraft(planId: string): Promise<void> {
  await deleteLocalState(textDraftKey(planId));
}

/** The plan's unsent notes, live (null while loading or when there are none). */
export function useTextDraft(planId: string | null): { draft: TextDraft | null; isLoading: boolean } {
  const { value, isLoading } = useLocalState<unknown>(textDraftKey(planId ?? ''));
  return { draft: planId ? parseTextDraft(value, planId) : null, isLoading };
}

/**
 * How many plans have unsent notes on this phone. Signing out deletes them with the rest of the
 * phone's local data, so the sign-out confirmation says so.
 */
export async function countUnsentNotes(): Promise<number> {
  const stored = await readLocalStateByPrefix<unknown>(TEXT_DRAFT_KEY_PREFIX);
  return stored.filter(({ key, value }) => draftHasText(parseTextDraft(value, key.slice(TEXT_DRAFT_KEY_PREFIX.length)))).length;
}

export type DraftSaver = {
  /** Saves this draft within a second (a later call in that second replaces it). */
  schedule(draft: Omit<TextDraft, 'v'>): void;
  /** Saves what is waiting now; resolves once every write so far is done. */
  flush(): Promise<void>;
  /** Deletes the plan's draft and saves nothing more (the notes were added). */
  discard(): Promise<void>;
};

/**
 * Keeps the notes screen's draft on the phone: saved at most a second after each change, at once on
 * flush() (a pause, "Add to plan"), when the screen closes and when the app leaves the foreground;
 * deleted when the notes are emptied. Writes run one after another, so a save that was already on its
 * way can never bring back a draft that discard() just deleted.
 */
export function useDraftSaver(planId: string): DraftSaver {
  const pending = useRef<Omit<TextDraft, 'v'> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const closed = useRef(false);
  /** The app is in the background (Android pauses JavaScript timers there). */
  const away = useRef(false);

  const write = useCallback((draft: Omit<TextDraft, 'v'>) => {
    chain.current = chain.current
      .then(() => (draftHasText(draft) ? saveTextDraft(draft) : clearTextDraft(draft.planId)))
      .catch(() => undefined);
    return chain.current;
  }, []);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const draft = pending.current;
    pending.current = null;
    return draft && !closed.current ? write(draft) : chain.current;
  }, [write]);

  const schedule = useCallback(
    (draft: Omit<TextDraft, 'v'>) => {
      if (closed.current) return;
      pending.current = draft;
      // In the background a timer would not run until the app came back (and Android may end the app
      // there first): a change then, such as the last words of a dictation the app just paused, is
      // saved at once.
      if (away.current) {
        void flush();
        return;
      }
      // Not restarted by each change: while words keep coming, they are still saved every second.
      timer.current ??= setTimeout(() => void flush(), TEXT_DRAFT_SAVE_MS);
    },
    [flush],
  );

  const discard = useCallback(() => {
    closed.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    chain.current = chain.current.then(() => clearTextDraft(planId)).catch(() => undefined);
    return chain.current;
  }, [planId]);

  // Closing the screen saves what is waiting.
  useEffect(() => () => void flush(), [flush]);

  // So does leaving the app, at once: its timer would wait for the app to come back.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      away.current = state !== 'active';
      if (away.current) void flush();
    });
    return () => subscription.remove();
  }, [flush]);

  return useMemo(() => ({ schedule, flush, discard }), [schedule, flush, discard]);
}
