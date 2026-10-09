/**
 * Checks a `study` request body before anything is read or written. Errors name fields and indexes,
 * never values: they go back to the app and into logs. Pure.
 */
import {
  type ApproveOutlineRequest,
  type ConfirmTranscriptsRequest,
  type JobRequest,
  KIND_FILE_TYPES,
  SOURCE_KINDS,
  type SourceKind,
  STUDY_ACTIONS,
  STUDY_LIMITS,
  type StudyRequest,
  type SubmitSourceRequest,
} from './contracts.ts';
import { isUuid } from './ids.ts';

export type Checked<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A file of a submitted source, as its path says. */
export interface ParsedFile {
  path: string;
  /** n of `<n>.<ext>`: the 1-based file number (= the page of a notes photo). */
  n: number;
  ext: string;
  /** The MIME type Storage must hold for this extension. */
  mime: string;
}

/** Splits `<user>/<source>/<n>.<ext>`; null if the path is not exactly that. */
export function parseFilePath(path: string, userId: string, sourceId: string, kind: SourceKind) {
  const m = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/([1-9][0-9]{0,2})\.([a-z]{3,4})$/.exec(path);
  if (!m || m[1] !== userId || m[2] !== sourceId) return null;
  const mime = KIND_FILE_TYPES[kind][m[4]];
  if (!mime) return null;
  return { path, n: Number(m[3]), ext: m[4], mime } satisfies ParsedFile;
}

/** An https URL without credentials, as Tracy's /ai/extract accepts a link. */
export function isUsableLink(url: string): boolean {
  if (url.length > STUDY_LIMITS.maxUrlChars) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && u.hostname.length > 0;
  } catch {
    return false;
  }
}

export function checkStudyRequest(body: unknown, userId: string): Checked<StudyRequest> {
  if (!isObject(body)) return { ok: false, errors: ['the body must be a JSON object'] };
  const action = body.action;
  if (typeof action !== 'string' || !(STUDY_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, errors: [`action must be one of ${STUDY_ACTIONS.join(', ')}`] };
  }
  switch (action) {
    case 'submit_source':
      return checkSubmit(body, userId);
    case 'confirm_transcripts':
      return checkConfirm(body);
    case 'approve_outline':
      return checkApprove(body);
    default:
      return checkJob(body, action as JobRequest['action']);
  }
}

function checkSubmit(b: Record<string, unknown>, userId: string): Checked<SubmitSourceRequest> {
  const errors: string[] = [];
  if (!isUuid(b.plan_id)) errors.push('plan_id must be a uuid');
  if (!isUuid(b.source_id)) errors.push('source_id must be a uuid');
  const kind = b.kind as SourceKind;
  if (!SOURCE_KINDS.includes(kind)) errors.push(`kind must be one of ${SOURCE_KINDS.join(', ')}`);
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title || title.length > STUDY_LIMITS.maxTitleChars) {
    errors.push(`title must be 1 to ${STUDY_LIMITS.maxTitleChars} characters`);
  }
  let url: string | null = null;
  if (kind === 'link') {
    if (typeof b.url !== 'string' || !isUsableLink(b.url)) {
      errors.push(`url must be an https address of at most ${STUDY_LIMITS.maxUrlChars} characters`);
    } else url = b.url;
  } else if (b.url !== undefined && b.url !== null) {
    errors.push('url is only for kind link');
  }
  const files = Array.isArray(b.files) ? b.files : null;
  if (!files) errors.push('files must be an array');
  if (errors.length) return { ok: false, errors };

  const list = files as unknown[];
  const range: Record<SourceKind, [number, number]> = {
    pdf: [1, 1],
    doc: [1, 1],
    link: [0, 0],
    notes: [1, STUDY_LIMITS.maxNotePhotos],
  };
  const [min, max] = range[kind];
  if (list.length < min || list.length > max) {
    errors.push(
      min === max ? `files must have exactly ${min} entr${min === 1 ? 'y' : 'ies'} for kind ${kind}` : `files must have ${min} to ${max} entries for kind ${kind}`,
    );
  }
  const numbers = new Set<number>();
  const parsed: { path: string }[] = [];
  list.forEach((f, i) => {
    const path = isObject(f) && typeof f.path === 'string' ? f.path : null;
    const p = path ? parseFilePath(path, userId, b.source_id as string, kind) : null;
    if (!p) {
      const exts = Object.keys(KIND_FILE_TYPES[kind]).join(', ');
      errors.push(`files[${i}].path must be <your user id>/<source_id>/<n>.<ext> with ext ${exts || '(none)'}`);
      return;
    }
    if (p.n > max) errors.push(`files[${i}].path numbers files from 1 to ${max}`);
    else if (numbers.has(p.n)) errors.push(`files[${i}].path repeats file number ${p.n}`);
    numbers.add(p.n);
    parsed.push({ path: p.path });
  });
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      action: 'submit_source',
      plan_id: b.plan_id as string,
      source_id: b.source_id as string,
      kind,
      title,
      url,
      files: parsed,
    },
  };
}

function checkConfirm(b: Record<string, unknown>): Checked<ConfirmTranscriptsRequest> {
  const errors: string[] = [];
  if (!isUuid(b.plan_id)) errors.push('plan_id must be a uuid');
  if (!isUuid(b.source_id)) errors.push('source_id must be a uuid');
  const files = b.files === undefined ? [] : b.files;
  if (!Array.isArray(files) || files.length > STUDY_LIMITS.maxNotePhotos) {
    errors.push(`files must be an array of at most ${STUDY_LIMITS.maxNotePhotos} entries`);
  } else {
    const seen = new Set<string>();
    files.forEach((f, i) => {
      if (!isObject(f) || !isUuid(f.id)) errors.push(`files[${i}].id must be a uuid`);
      else if (seen.has(f.id)) errors.push(`files[${i}].id is listed twice`);
      else seen.add(f.id);
      if (!isObject(f) || typeof f.transcript !== 'string' || f.transcript.length > STUDY_LIMITS.maxTranscriptChars) {
        errors.push(`files[${i}].transcript must be a string of at most ${STUDY_LIMITS.maxTranscriptChars} characters`);
      }
    });
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      action: 'confirm_transcripts',
      plan_id: b.plan_id as string,
      source_id: b.source_id as string,
      files: (files as { id: string; transcript: string }[]).map((f) => ({ id: f.id, transcript: f.transcript })),
    },
  };
}

function checkApprove(b: Record<string, unknown>): Checked<ApproveOutlineRequest> {
  const errors: string[] = [];
  if (!isUuid(b.plan_id)) errors.push('plan_id must be a uuid');
  const sourceId = b.source_id === undefined ? null : b.source_id;
  if (sourceId !== null && !isUuid(sourceId)) errors.push('source_id must be a uuid or null');
  const topics = b.topics;
  if (!Array.isArray(topics) || topics.length > STUDY_LIMITS.maxApproveTopics) {
    errors.push(`topics must be an array of at most ${STUDY_LIMITS.maxApproveTopics} entries`);
  } else {
    topics.forEach((t, i) => {
      if (!isObject(t) || !isUuid(t.id)) errors.push(`topics[${i}].id must be a uuid`);
      if (!isObject(t) || typeof t.keep !== 'boolean') errors.push(`topics[${i}].keep must be true or false`);
      if (isObject(t) && t.title !== undefined && t.title !== null) {
        const title = typeof t.title === 'string' ? t.title.trim() : '';
        if (!title || title.length > STUDY_LIMITS.maxTopicTitleChars) {
          errors.push(`topics[${i}].title must be 1 to ${STUDY_LIMITS.maxTopicTitleChars} characters`);
        }
      }
    });
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      action: 'approve_outline',
      plan_id: b.plan_id as string,
      source_id: sourceId as string | null,
      topics: (topics as Record<string, unknown>[]).map((t) => ({
        id: t.id as string,
        keep: t.keep as boolean,
        ...(typeof t.title === 'string' ? { title: t.title.trim() } : {}),
      })),
    },
  };
}

function checkJob(b: Record<string, unknown>, action: JobRequest['action']): Checked<JobRequest> {
  if (!isUuid(b.job_id)) return { ok: false, errors: ['job_id must be a uuid'] };
  return { ok: true, value: { action, job_id: b.job_id } };
}
