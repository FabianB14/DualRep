/**
 * Adding material to a plan (Phase 2 decision 7): pick → validate → prepare (copy a document, shrink
 * and re-encode photos) → upload to Storage → submit to the `study` function. Online only: the screen
 * says so clearly when there is no connection (studyErrorMessage / uploadErrorMessage).
 *
 * - Files go to the private bucket `sources` at `<user_id>/<source_id>/<n>.<ext>` (n = the 1-based
 *   file number; for notes, the photo's page), with an explicit content type: Storage's MIME
 *   allow-list checks the header, and storage-js would otherwise send text/plain.
 * - The phone makes the source id (so it can name the folder before anything exists on the server);
 *   the study function then creates the sources, plan_sources and source_files rows itself and
 *   queues the work. The phone writes none of those rows: they arrive with the next sync. A retry
 *   after a failure reuses the same source id, so uploads overwrite (x-upsert) and the submit is
 *   recognised as the same one (already_submitted).
 * - Documents (PDF, DOCX) ≤ 25 MiB, one per source. They are picked without the picker's own cache
 *   copy (that copy has no size limit and runs before the app can check the size), checked, then
 *   copied into the app's cache, because a picked content:// grant lasts only while the app lives.
 *   Up to 5 MiB they upload through supabase-js from `File.bytes()`; larger ones stream natively
 *   from disk with `File.upload` (in JavaScript the body would be copied and base64-encoded,
 *   3–4× its size in memory).
 * - Photos (≤ 20 per notes source): one decode with expo-image-manipulator, long edge shrunk to
 *   ≤ 2576 px (Claude's high-resolution limit; never enlarged), saved as JPEG 0.85. That pass also
 *   applies the EXIF rotation, converts HEIC, and drops every EXIF tag, GPS included (the picker is
 *   asked for the original bytes, quality 1, so nothing is decoded twice). Photos over 50 megapixels
 *   are refused: decoding one takes 200 MB or more of memory.
 * - Taking a photo needs Android 10 (API 29) or later: below that, expo-image-picker also asks for
 *   WRITE_EXTERNAL_STORAGE, which DualRep blocks. The gallery and files work everywhere.
 *
 * APIs as in expo-document-picker 57.0.3, expo-image-picker 57.0.20, expo-image-manipulator 57.0.21
 * and expo-file-system 57.0.7 (build/*.d.ts).
 */
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat, type ImageRef } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import { readEnv } from '@/lib/env';
import { newId } from '@/lib/ids';

import {
  isStudyApiError,
  KIND_FILE_TYPES,
  STUDY_API_LIMITS,
  StudyApiError,
  studyErrorMessage,
  submitSource,
  type SourceKind,
  type StudyFunctionsClient,
  type SubmitSourceResponse,
} from './studyApi';

export const UPLOAD_RULES = {
  /** = the bucket's file_size_limit. */
  maxFileBytes: STUDY_API_LIMITS.maxFileBytes,
  maxPhotos: STUDY_API_LIMITS.maxNotePhotos,
  /** Claude 4.7+ high-resolution long edge. */
  longEdge: 2576,
  jpegQuality: 0.85,
  /** A decode takes about 4 bytes per pixel: 50 MP ≈ 200 MB. */
  maxMegapixels: 50,
  /** Above this, a document uploads natively from disk instead of through JavaScript memory. */
  nativeUploadBytes: 5 * 1024 * 1024,
  maxTitleChars: STUDY_API_LIMITS.maxTitleChars,
  maxUrlChars: STUDY_API_LIMITS.maxUrlChars,
} as const;

export const BUCKET = 'sources';
const PDF = KIND_FILE_TYPES.pdf.pdf;
const DOCX = KIND_FILE_TYPES.doc.docx;
export const DOCUMENT_MIME_TYPES = [PDF, DOCX] as const;
/** Photo types accepted from the picker; all are re-encoded as JPEG before upload. */
export const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;

// ---- What was picked ----------------------------------------------------------------------------

export type PickedDocument = { uri: string; name: string; size: number | null; mimeType: string | null };
export type PickedPhoto = {
  uri: string;
  /** 0 when the picker could not tell. */
  width: number;
  height: number;
  fileSize: number | null;
  mimeType: string | null;
  fileName: string | null;
};

// ---- Problems the user can fix ------------------------------------------------------------------

export type UploadProblemCode =
  | 'too_large'
  | 'wrong_type'
  | 'empty'
  | 'too_many'
  | 'too_many_pixels'
  | 'no_files'
  | 'bad_link'
  | 'bad_title'
  | 'unreadable';

export class UploadError extends Error {
  readonly code: UploadProblemCode;
  /** Which photo (0-based), when it is about one. */
  readonly index: number | null;
  constructor(code: UploadProblemCode, message: string, index: number | null = null) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
    this.index = index;
  }
}

const MIB = 1024 * 1024;

function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(name.trim());
  return match ? match[1].toLowerCase() : '';
}

export type DocumentTarget = { kind: 'pdf' | 'doc'; ext: 'pdf' | 'docx'; contentType: string };

/** MIME types that say nothing about the content (some file managers report these). */
const GENERIC_MIME_TYPES = ['', 'application/octet-stream', 'binary/octet-stream', 'application/x-download', 'application/force-download'];

/**
 * What a picked document is: by its MIME type, or by its name when the type says nothing. null for
 * anything but PDF and DOCX (old .doc files are not supported).
 */
export function documentTarget(doc: Pick<PickedDocument, 'name' | 'mimeType'>): DocumentTarget | null {
  const mime = (doc.mimeType ?? '').toLowerCase().split(';')[0].trim();
  const generic = GENERIC_MIME_TYPES.includes(mime);
  const ext = extensionOf(doc.name);
  if (mime === PDF || (generic && ext === 'pdf')) return { kind: 'pdf', ext: 'pdf', contentType: PDF };
  if (mime === DOCX || (generic && ext === 'docx')) return { kind: 'doc', ext: 'docx', contentType: DOCX };
  return null;
}

/** Checks a picked document before anything is copied. */
export function validateDocument(doc: PickedDocument): DocumentTarget {
  const target = documentTarget(doc);
  if (!target) throw new UploadError('wrong_type', 'Only PDF and Word (.docx) files can be added.');
  if (doc.size !== null && doc.size === 0) throw new UploadError('empty', `${doc.name || 'This file'} is empty.`);
  if (doc.size !== null && doc.size > UPLOAD_RULES.maxFileBytes) {
    throw new UploadError('too_large', `${doc.name || 'This file'} is larger than ${UPLOAD_RULES.maxFileBytes / MIB} MB.`);
  }
  return target;
}

/** Checks picked photos (count, type, size in pixels) before any is decoded. */
export function validatePhotos(photos: readonly PickedPhoto[]): void {
  if (photos.length === 0) throw new UploadError('no_files', 'Pick at least one photo of your notes.');
  if (photos.length > UPLOAD_RULES.maxPhotos) {
    throw new UploadError('too_many', `Up to ${UPLOAD_RULES.maxPhotos} photos per set of notes. Add the rest as another set.`);
  }
  photos.forEach((photo, index) => {
    const mime = (photo.mimeType ?? '').toLowerCase();
    const ext = extensionOf(photo.fileName ?? photo.uri);
    const known = PHOTO_MIME_TYPES.includes(mime as never) || (mime === '' && ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(ext));
    if (!known) throw new UploadError('wrong_type', `Photo ${index + 1} isn’t a JPEG, PNG, WebP or HEIC image.`, index);
    if (photo.width > 0 && photo.height > 0 && photo.width * photo.height > UPLOAD_RULES.maxMegapixels * 1_000_000) {
      throw new UploadError(
        'too_many_pixels',
        `Photo ${index + 1} is over ${UPLOAD_RULES.maxMegapixels} megapixels. Take it at the camera’s normal resolution.`,
        index,
      );
    }
  });
}

/**
 * A link source's address: https only, no user name or password in it, at most 2048 characters (what
 * the study function and Tracy accept).
 */
export function validateLink(url: string): string {
  const trimmed = url.trim();
  const ok =
    trimmed.length <= UPLOAD_RULES.maxUrlChars &&
    /^https:\/\/[^\s/?#@:]+(:\d{1,5})?([/?#]\S*)?$/i.test(trimmed);
  if (!ok) throw new UploadError('bad_link', 'Use a web address that starts with https://.');
  return trimmed;
}

/** The source's title: given, else from the material. 1 to 200 characters. */
export function sourceTitle(given: string | null | undefined, fallback: string): string {
  const title = (given?.trim() || fallback.trim()).slice(0, UPLOAD_RULES.maxTitleChars).trim();
  if (!title) throw new UploadError('bad_title', 'Give the material a name.');
  return title;
}

/** A document's default title: its file name without the extension. */
export function documentTitle(name: string): string {
  return name.trim().replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'Document';
}

/** A notes source's default title: "Notes, 9 Oct". */
export function notesTitle(nowMs: number): string {
  return `Notes, ${new Date(nowMs).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

/** A link's default title: its host and path, without the scheme. */
export function linkTitle(url: string): string {
  return url.replace(/^https:\/\//i, '').replace(/\/$/, '');
}

/**
 * The resize decision for a photo of width × height: shrink the long edge to `longEdge`, passing only
 * that dimension (the manipulator keeps the aspect ratio; passing both would distort). null when the
 * photo is small enough (it is never enlarged) or its size is unknown.
 */
export function resizeFor(width: number, height: number, longEdge: number = UPLOAD_RULES.longEdge): { width: number } | { height: number } | null {
  if (!(width > 0) || !(height > 0) || Math.max(width, height) <= longEdge) return null;
  return width >= height ? { width: longEdge } : { height: longEdge };
}

/** Where a file goes in the bucket: `<user_id>/<source_id>/<n>.<ext>` (lowercase ids). */
export function storagePath(userId: string, sourceId: string, n: number, ext: string): string {
  if (!Number.isInteger(n) || n < 1 || n > 999) throw new RangeError(`File number must be 1 to 999, got ${n}`);
  return `${userId.toLowerCase()}/${sourceId.toLowerCase()}/${n}.${ext}`;
}

// ---- Picking ------------------------------------------------------------------------------------

/** Picks PDF / Word documents (each becomes its own source). [] when cancelled. */
export async function pickDocuments(): Promise<PickedDocument[]> {
  const result = await DocumentPicker.getDocumentAsync({
    type: [...DOCUMENT_MIME_TYPES],
    multiple: true,
    // No picker cache copy: it would copy any size before we can check it (see the header).
    copyToCacheDirectory: false,
  });
  if (result.canceled) return [];
  return result.assets.map((asset) => ({
    uri: asset.uri,
    name: asset.name,
    size: typeof asset.size === 'number' ? asset.size : null,
    mimeType: asset.mimeType ?? null,
  }));
}

const PHOTO_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  // 1 = the original bytes, copied without decoding; the one decode happens in preparePhoto.
  quality: 1,
  exif: false,
  base64: false,
  allowsEditing: false,
};

function toPickedPhoto(asset: ImagePicker.ImagePickerAsset): PickedPhoto {
  return {
    uri: asset.uri,
    width: asset.width || 0,
    height: asset.height || 0,
    fileSize: typeof asset.fileSize === 'number' ? asset.fileSize : null,
    mimeType: asset.mimeType ?? null,
    fileName: asset.fileName ?? null,
  };
}

/** Picks photos from the gallery (the system Photo Picker: no permission). [] when cancelled. */
export async function pickPhotos(limit: number = UPLOAD_RULES.maxPhotos): Promise<PickedPhoto[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    ...PHOTO_OPTIONS,
    allowsMultipleSelection: true,
    selectionLimit: Math.max(1, Math.min(limit, UPLOAD_RULES.maxPhotos)),
    orderedSelection: true,
  });
  return result.canceled ? [] : result.assets.map(toPickedPhoto);
}

/** Whether "Take a photo" can work here (see the header: Android 10 or later). */
export function canTakePhoto(os: string = Platform.OS, version: string | number = Platform.Version): boolean {
  if (os !== 'android') return os === 'ios';
  return Number(version) >= 29;
}

/**
 * Takes one photo with the system camera, asking for the camera permission in context first.
 * 'denied' when the permission was refused, null when cancelled.
 */
export async function takePhoto(): Promise<PickedPhoto | 'denied' | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) return 'denied';
  const result = await ImagePicker.launchCameraAsync(PHOTO_OPTIONS);
  return result.canceled ? null : (result.assets[0] ? toPickedPhoto(result.assets[0]) : null);
}

/**
 * A photo taken while Android stopped the app (the camera app in front): call when the add-material
 * screen mounts. [] when there is none.
 */
export async function recoverPendingPhotos(): Promise<PickedPhoto[]> {
  try {
    const pending = await ImagePicker.getPendingResultAsync();
    if (!pending || !('canceled' in pending) || pending.canceled) return [];
    return pending.assets.map(toPickedPhoto);
  } catch {
    return [];
  }
}

// ---- Preparing ----------------------------------------------------------------------------------

/** The app's cache folder for one source's prepared files. */
export function stagingDirectory(sourceId: string): Directory {
  return new Directory(Paths.cache, 'dualrep-uploads', sourceId);
}

export type PreparedFile = { uri: string; path: string; contentType: string; size: number; temporary: boolean };

/** Copies a picked document into the app's cache (checked again by its real size). */
export async function stageDocument(doc: PickedDocument, target: DocumentTarget, userId: string, sourceId: string): Promise<PreparedFile> {
  const dir = stagingDirectory(sourceId);
  dir.create({ intermediates: true, idempotent: true });
  const dest = new File(dir, `1.${target.ext}`);
  try {
    await new File(doc.uri).copy(dest, { overwrite: true });
  } catch {
    throw new UploadError('unreadable', `${doc.name || 'The file'} couldn’t be read. Pick it again.`);
  }
  const size = dest.size;
  if (size === 0) {
    deleteQuietly(dest.uri);
    throw new UploadError('empty', `${doc.name || 'This file'} is empty.`);
  }
  if (size > UPLOAD_RULES.maxFileBytes) {
    deleteQuietly(dest.uri);
    throw new UploadError('too_large', `${doc.name || 'This file'} is larger than ${UPLOAD_RULES.maxFileBytes / MIB} MB.`);
  }
  return { uri: dest.uri, path: storagePath(userId, sourceId, 1, target.ext), contentType: target.contentType, size, temporary: true };
}

function release(ref: { release(): void } | null | undefined): void {
  try {
    ref?.release();
  } catch {
    // Already released.
  }
}

/**
 * One photo, ready to upload: decoded once, rotated upright, long edge ≤ 2576 px, JPEG 0.85, no EXIF.
 * When the picker could not tell the size (or told it wrong), the rendered image is measured and
 * shrunk in a second step.
 */
export async function preparePhoto(photo: PickedPhoto, userId: string, sourceId: string, n: number): Promise<PreparedFile> {
  const context = ImageManipulator.manipulate(photo.uri);
  let image: ImageRef | null = null;
  let second: ReturnType<typeof ImageManipulator.manipulate> | null = null;
  try {
    const resize = resizeFor(photo.width, photo.height);
    if (resize) context.resize(resize);
    image = await context.renderAsync();
    const again = resizeFor(image.width, image.height);
    if (again) {
      second = ImageManipulator.manipulate(image);
      second.resize(again);
      const smaller = await second.renderAsync();
      release(image);
      image = smaller;
    }
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: UPLOAD_RULES.jpegQuality });
    const size = new File(saved.uri).size;
    if (size > UPLOAD_RULES.maxFileBytes) {
      deleteQuietly(saved.uri);
      throw new UploadError('too_large', `Photo ${n} is too large even after shrinking it.`, n - 1);
    }
    return { uri: saved.uri, path: storagePath(userId, sourceId, n, 'jpg'), contentType: 'image/jpeg', size, temporary: true };
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError('unreadable', `Photo ${n} couldn’t be read. Pick it again or leave it out.`, n - 1);
  } finally {
    release(image);
    release(second);
    release(context);
  }
}

function deleteQuietly(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Gone already; the cache is the system's to clear anyway.
  }
}

// ---- Uploading ----------------------------------------------------------------------------------

/** The parts of a Supabase client the upload uses (SupabaseClient satisfies it). */
export type UploadClient = StudyFunctionsClient & {
  storage: {
    from(bucket: string): {
      upload(path: string, body: Uint8Array, options: { contentType: string; upsert: boolean }): Promise<{ data: unknown; error: unknown }>;
    };
  };
  auth: { getSession(): Promise<{ data: { session: { access_token: string } | null }; error: unknown }> };
};

export type UploadContext = { client: UploadClient; supabaseUrl: string; publishableKey: string };

/** The upload context for the app's client, or null when the build has no Supabase configuration. */
export function uploadContextFor(client: UploadClient | null): UploadContext | null {
  const env = readEnv();
  if (!client || !env.ok) return null;
  return { client, supabaseUrl: env.supabaseUrl, publishableKey: env.supabaseKey };
}

/**
 * A failed Storage request as the app's error: no response → offline; 401 → signed out; too large or
 * the wrong type → an UploadError the user can act on; anything else → a server error. Storage may
 * report the real status in the body's `statusCode` (e.g. "413" under a 400).
 */
export function storageFailure(status: number | null, statusCode: string | null, message: string): Error {
  const code = Number(statusCode ?? NaN);
  const effective = Number.isFinite(code) && code >= 400 ? code : status;
  if (effective === null) return new StudyApiError('offline');
  if (effective === 413 || /maximum allowed size|too large/i.test(message)) {
    return new UploadError('too_large', `The file is larger than ${UPLOAD_RULES.maxFileBytes / MIB} MB.`);
  }
  if (effective === 415 || /mime type|invalid_mime/i.test(message)) {
    return new UploadError('wrong_type', 'This kind of file can’t be added.');
  }
  if (effective === 401) return new StudyApiError('signed_out', { status: effective });
  if (effective === 403) return new StudyApiError('forbidden', { status: effective });
  if (effective === 404) return new StudyApiError('not_configured', { status: effective });
  return new StudyApiError('server', { status: effective });
}

function fromStorageError(error: unknown): Error {
  const e = (typeof error === 'object' && error !== null ? error : {}) as {
    name?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };
  if (e.name === 'StorageUnknownError' || e.status === undefined) return new StudyApiError('offline');
  return storageFailure(
    typeof e.status === 'number' ? e.status : Number(e.status) || 500,
    typeof e.statusCode === 'string' ? e.statusCode : null,
    typeof e.message === 'string' ? e.message : '',
  );
}

export type UploadProgress = { bytesSent: number; totalBytes: number };

/** Uploads one prepared file to its path (overwriting: a retry of the same path succeeds). */
export async function uploadFile(
  context: UploadContext,
  file: PreparedFile,
  options: { onProgress?: (progress: UploadProgress) => void; signal?: AbortSignal } = {},
): Promise<void> {
  if (options.signal?.aborted) throw new StudyApiError('cancelled');
  if (file.size <= UPLOAD_RULES.nativeUploadBytes) {
    let bytes: Uint8Array;
    try {
      bytes = await new File(file.uri).bytes();
    } catch {
      throw new UploadError('unreadable', 'A prepared file couldn’t be read. Try again.');
    }
    let result: { data: unknown; error: unknown };
    try {
      result = await context.client.storage.from(BUCKET).upload(file.path, bytes, { contentType: file.contentType, upsert: true });
    } catch (error) {
      throw fromStorageError(error);
    }
    if (result.error) throw fromStorageError(result.error);
    options.onProgress?.({ bytesSent: file.size, totalBytes: file.size });
    return;
  }

  // Large documents: streamed from disk by the native module (OkHttp), with progress.
  let token: string | null = null;
  try {
    const { data } = await context.client.auth.getSession();
    token = data.session?.access_token ?? null;
  } catch {
    token = null;
  }
  if (!token) throw new StudyApiError('signed_out');
  let response: { status: number; body: string };
  try {
    response = await new File(file.uri).upload(`${context.supabaseUrl}/storage/v1/object/${BUCKET}/${file.path}`, {
      httpMethod: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: context.publishableKey,
        // A binary body carries no type unless it is set here (the mimeType option is multipart only).
        'Content-Type': file.contentType,
        'x-upsert': 'true',
      },
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    // Rejected only for an I/O error or a cancel (non-2xx answers resolve).
    throw options.signal?.aborted ? new StudyApiError('cancelled') : new StudyApiError('offline');
  }
  if (response.status >= 200 && response.status < 300) return;
  let statusCode: string | null = null;
  let message = '';
  try {
    const body = JSON.parse(response.body) as { statusCode?: unknown; message?: unknown; error?: unknown };
    statusCode = typeof body.statusCode === 'string' ? body.statusCode : null;
    message = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : '';
  } catch {
    // Not JSON (a proxy page).
  }
  throw storageFailure(response.status, statusCode, message);
}

// ---- The whole flow -----------------------------------------------------------------------------

export type MaterialInput =
  | { kind: 'pdf' | 'doc'; document: PickedDocument; title?: string | null }
  | { kind: 'notes'; photos: PickedPhoto[]; title?: string | null }
  | { kind: 'link'; url: string; title?: string | null };

export type AddMaterialProgress = {
  phase: 'preparing' | 'uploading' | 'submitting' | 'done';
  /** Files finished in this phase, and how many there are. */
  done: number;
  total: number;
  /** Bytes sent of the file being uploaded (when known). */
  bytesSent?: number;
  totalBytes?: number;
};

export type AddMaterialOptions = {
  userId: string;
  planId: string;
  /** Reuse the id of a failed attempt so a retry overwrites instead of starting over. */
  sourceId?: string;
  onProgress?: (progress: AddMaterialProgress) => void;
  signal?: AbortSignal;
  now?: number;
  /**
   * Runs after the uploads, before the submit: the screen waits here for the phone's own writes to
   * reach the server (waitForUploads), because the study function looks the plan up there and a
   * plan made offline may not have arrived yet.
   */
  beforeSubmit?: () => Promise<unknown>;
  /** Waits between submit attempts (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Waits before each new submit attempt while the study function cannot find the plan yet (404
 * not_found): a plan made offline reaches the server with the phone's next upload, usually within
 * seconds of coming online. The files are already in Storage, so asking again is cheap and safe.
 */
export const SUBMIT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type AddMaterialResult = SubmitSourceResponse & { sourceId: string };

/**
 * Adds material to a plan: validates, prepares, uploads, submits. Rejects with an UploadError (a
 * problem with the material the user can fix) or a StudyApiError (offline, cap reached, …); see
 * uploadErrorMessage. Prepared copies are deleted afterwards, whatever happens.
 */
export async function addMaterial(context: UploadContext | null, input: MaterialInput, options: AddMaterialOptions): Promise<AddMaterialResult> {
  if (!context) throw new StudyApiError('not_configured');
  const sourceId = (options.sourceId ?? newId()).toLowerCase();
  const userId = options.userId.toLowerCase();
  const progress = options.onProgress ?? (() => undefined);
  const checkCancel = () => {
    if (options.signal?.aborted) throw new StudyApiError('cancelled');
  };

  let kind: SourceKind;
  let title: string;
  let url: string | null = null;
  const prepared: PreparedFile[] = [];
  try {
    if (input.kind === 'link') {
      kind = 'link';
      url = validateLink(input.url);
      title = sourceTitle(input.title, linkTitle(url));
    } else if (input.kind === 'notes') {
      kind = 'notes';
      validatePhotos(input.photos);
      title = sourceTitle(input.title, notesTitle(options.now ?? Date.now()));
      for (let i = 0; i < input.photos.length; i += 1) {
        checkCancel();
        progress({ phase: 'preparing', done: i, total: input.photos.length });
        prepared.push(await preparePhoto(input.photos[i], userId, sourceId, i + 1));
      }
    } else {
      const target = validateDocument(input.document);
      kind = target.kind;
      title = sourceTitle(input.title, documentTitle(input.document.name));
      checkCancel();
      progress({ phase: 'preparing', done: 0, total: 1 });
      prepared.push(await stageDocument(input.document, target, userId, sourceId));
    }

    for (let i = 0; i < prepared.length; i += 1) {
      checkCancel();
      progress({ phase: 'uploading', done: i, total: prepared.length });
      await uploadFile(context, prepared[i], {
        signal: options.signal,
        onProgress: ({ bytesSent, totalBytes }) => progress({ phase: 'uploading', done: i, total: prepared.length, bytesSent, totalBytes }),
      });
    }

    checkCancel();
    progress({ phase: 'submitting', done: 0, total: 1 });
    await options.beforeSubmit?.().catch(() => undefined);
    const request = { plan_id: options.planId, source_id: sourceId, kind, title, url, files: prepared.map((file) => ({ path: file.path })) };
    const sleep = options.sleep ?? defaultSleep;
    for (let attempt = 0; ; attempt += 1) {
      checkCancel();
      try {
        const response = await submitSource(context.client, request, { signal: options.signal });
        progress({ phase: 'done', done: 1, total: 1 });
        return { ...response, sourceId };
      } catch (error) {
        const planNotThereYet = isStudyApiError(error) && error.kind === 'not_found';
        if (!planNotThereYet || attempt >= SUBMIT_RETRY_DELAYS_MS.length) throw error;
        await sleep(SUBMIT_RETRY_DELAYS_MS[attempt]);
      }
    }
  } finally {
    for (const file of prepared) if (file.temporary) deleteQuietly(file.uri);
  }
}

/** What to tell the user about a failed addMaterial. */
export function uploadErrorMessage(error: unknown): string {
  if (error instanceof UploadError) return error.message;
  if (isStudyApiError(error)) return studyErrorMessage(error);
  return 'Something went wrong. Try again.';
}
