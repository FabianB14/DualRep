import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { SupabaseClient } from '@supabase/supabase-js';

import { StudyApiError } from '../studyApi';
import {
  addMaterial,
  canTakePhoto,
  documentTarget,
  documentTitle,
  linkTitle,
  notesTitle,
  pickDocuments,
  pickPhotos,
  preparePhoto,
  recoverPendingPhotos,
  resizeFor,
  sourceTitle,
  stageDocument,
  storageFailure,
  storagePath,
  SUBMIT_RETRY_DELAYS_MS,
  takePhoto,
  UploadError,
  uploadContextFor,
  uploadErrorMessage,
  uploadFile,
  UPLOAD_RULES,
  validateDocument,
  validateLink,
  validatePhotos,
  type PickedDocument,
  type PickedPhoto,
  type UploadClient,
  type UploadContext,
} from '../upload';

// ---- Fakes for the Expo modules ------------------------------------------------------------------

jest.mock('expo-file-system', () => {
  const state = {
    sizes: new Map<string, number>(),
    deleted: [] as string[],
    copies: [] as { from: string; to: string; options: unknown }[],
    created: [] as { uri: string; options: unknown }[],
    uploads: [] as { from: string; url: string; options: Record<string, unknown> }[],
    copyError: null as Error | null,
    bytesError: null as Error | null,
    uploadResult: { status: 200, body: '{}', headers: {} } as { status: number; body: string; headers: Record<string, string> } | Error,
  };
  const join = (parts: unknown[]) => parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/');
  class Directory {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
    create(options: unknown) {
      state.created.push({ uri: this.uri, options });
    }
  }
  class File {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
    get size() {
      return state.sizes.get(this.uri) ?? 0;
    }
    get exists() {
      return state.sizes.has(this.uri);
    }
    async copy(dest: { uri: string }, options: unknown) {
      if (state.copyError) throw state.copyError;
      state.copies.push({ from: this.uri, to: dest.uri, options });
      state.sizes.set(dest.uri, state.sizes.get(this.uri) ?? 0);
    }
    async bytes() {
      if (state.bytesError) throw state.bytesError;
      return new Uint8Array(state.sizes.get(this.uri) ?? 0);
    }
    async upload(url: string, options: Record<string, unknown>) {
      state.uploads.push({ from: this.uri, url, options });
      if (state.uploadResult instanceof Error) throw state.uploadResult;
      return state.uploadResult;
    }
    delete() {
      state.deleted.push(this.uri);
      state.sizes.delete(this.uri);
    }
  }
  return { File, Directory, Paths: { cache: new Directory('file:///cache') }, __state: state };
});

jest.mock('expo-image-manipulator', () => {
  const log: unknown[][] = [];
  const settings = { rendered: [] as { width: number; height: number }[], fail: false, savedSize: 900_000 };
  let saves = 0;
  const image = (width: number, height: number) => ({
    width,
    height,
    saveAsync: jest.fn(async (options: unknown) => {
      log.push(['save', width, height, options]);
      saves += 1;
      const uri = `file:///cache/ImageManipulator/out-${saves}.jpg`;
      (jest.requireMock('expo-file-system') as { __state: { sizes: Map<string, number> } }).__state.sizes.set(uri, settings.savedSize);
      return { uri, width, height };
    }),
    release: jest.fn(() => log.push(['release image', width, height])),
  });
  const manipulate = jest.fn((source: unknown) => {
    log.push(['manipulate', typeof source === 'string' ? source : 'image']);
    return {
      resize: jest.fn(function (this: unknown, size: unknown) {
        log.push(['resize', size]);
        return this;
      }),
      renderAsync: jest.fn(async () => {
        if (settings.fail) throw new Error('decode failed');
        const next = settings.rendered.shift() ?? { width: 1000, height: 800 };
        log.push(['render', next.width, next.height]);
        return image(next.width, next.height);
      }),
      release: jest.fn(() => log.push(['release context'])),
    };
  });
  return {
    ImageManipulator: { manipulate },
    SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
    __log: log,
    __settings: settings,
  };
});

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  getPendingResultAsync: jest.fn(),
}));
jest.mock('../../../lib/env', () => ({
  readEnv: jest.fn(() => ({ ok: true, supabaseUrl: 'https://ref.supabase.co', supabaseKey: 'sb_publishable_x', powersyncUrl: 'https://ps' })),
}));
let mockIds = 0;
jest.mock('../../../lib/ids', () => ({ newId: () => `A0000000-0000-4000-8000-00000000000${(mockIds += 1)}` }));

type AnyMock = jest.Mock<(...args: any[]) => any>;
const fs = (jest.requireMock('expo-file-system') as {
  __state: {
    sizes: Map<string, number>;
    deleted: string[];
    copies: { from: string; to: string; options: unknown }[];
    created: { uri: string; options: unknown }[];
    uploads: { from: string; url: string; options: Record<string, unknown> }[];
    copyError: Error | null;
    bytesError: Error | null;
    uploadResult: { status: number; body: string; headers: Record<string, string> } | Error;
  };
}).__state;
const manipulator = jest.requireMock('expo-image-manipulator') as {
  ImageManipulator: { manipulate: AnyMock };
  __log: unknown[][];
  __settings: { rendered: { width: number; height: number }[]; fail: boolean; savedSize: number };
};
const docPicker = jest.requireMock('expo-document-picker') as { getDocumentAsync: AnyMock };
const imagePicker = jest.requireMock('expo-image-picker') as Record<string, AnyMock>;
const env = jest.requireMock('../../../lib/env') as { readEnv: AnyMock };

const USER = '11111111-1111-4111-8111-111111111111';
const SOURCE = 'a0000000-0000-4000-8000-000000000009';
const PLAN = '90000000-0000-4000-8000-000000000001';
const MIB = 1024 * 1024;

const doc = (extra: Partial<PickedDocument> = {}): PickedDocument => ({
  uri: 'content://docs/42',
  name: 'Lecture 3.pdf',
  size: 2 * MIB,
  mimeType: 'application/pdf',
  ...extra,
});
const photo = (extra: Partial<PickedPhoto> = {}): PickedPhoto => ({
  uri: 'file:///cache/ImagePicker/p1.jpg',
  width: 4032,
  height: 3024,
  fileSize: 3 * MIB,
  mimeType: 'image/jpeg',
  fileName: 'p1.jpg',
  ...extra,
});

function fakeClient() {
  const storageUpload = jest.fn<(path: string, body: Uint8Array, options: unknown) => Promise<{ data: unknown; error: unknown }>>(
    async () => ({ data: { path: 'x' }, error: null }),
  );
  const from = jest.fn(() => ({ upload: storageUpload }));
  const invoke = jest.fn(async (_name: string, options: { body: unknown }) => ({
    data: { ok: true, source_id: (options.body as { source_id: string }).source_id, status: 'processing', job_ids: ['j1'], already_submitted: false },
    error: null,
  }));
  const getSession = jest.fn(async () => ({ data: { session: { access_token: 'jwt-1' } as { access_token: string } | null }, error: null }));
  const client: UploadClient = { storage: { from }, functions: { invoke }, auth: { getSession } };
  const context: UploadContext = { client, supabaseUrl: 'https://ref.supabase.co', publishableKey: 'sb_publishable_x' };
  return { context, storageUpload, from, invoke, getSession };
}

beforeEach(() => {
  jest.clearAllMocks();
  fs.sizes.clear();
  fs.deleted.length = 0;
  fs.copies.length = 0;
  fs.created.length = 0;
  fs.uploads.length = 0;
  fs.copyError = null;
  fs.bytesError = null;
  fs.uploadResult = { status: 200, body: '{}', headers: {} };
  manipulator.__log.length = 0;
  manipulator.__settings.rendered = [];
  manipulator.__settings.fail = false;
  manipulator.__settings.savedSize = 900_000;
});

// ---- Validation ----------------------------------------------------------------------------------

describe('validateDocument', () => {
  it('accepts PDF and DOCX, by type or (when the type says nothing) by name', () => {
    expect(validateDocument(doc())).toEqual({ kind: 'pdf', ext: 'pdf', contentType: 'application/pdf' });
    expect(validateDocument(doc({ name: 'Essay.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))).toEqual({
      kind: 'doc',
      ext: 'docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(documentTarget({ name: 'scan.PDF', mimeType: 'application/octet-stream' })?.kind).toBe('pdf');
    expect(documentTarget({ name: 'notes.docx', mimeType: null })?.kind).toBe('doc');
    expect(documentTarget({ name: 'odd.pdf', mimeType: 'image/png' })).toBeNull();
    expect(documentTarget({ name: 'old.doc', mimeType: 'application/msword' })).toBeNull();
  });

  it('refuses other types, empty files and files over 25 MB; an unknown size is checked after copying', () => {
    const fail = (d: PickedDocument) => {
      try {
        validateDocument(d);
      } catch (error) {
        return (error as UploadError).code;
      }
      return null;
    };
    expect(fail(doc({ name: 'pic.png', mimeType: 'image/png' }))).toBe('wrong_type');
    expect(fail(doc({ size: 0 }))).toBe('empty');
    expect(fail(doc({ size: 25 * MIB + 1 }))).toBe('too_large');
    expect(fail(doc({ size: 25 * MIB }))).toBeNull();
    expect(fail(doc({ size: null }))).toBeNull();
    expect(() => validateDocument(doc({ size: 30 * MIB }))).toThrow('Lecture 3.pdf is larger than 25 MB.');
  });
});

describe('validatePhotos', () => {
  it('needs 1 to 20 photos', () => {
    expect(() => validatePhotos([])).toThrow(expect.objectContaining({ code: 'no_files' }));
    expect(() => validatePhotos(Array.from({ length: 21 }, () => photo()))).toThrow(expect.objectContaining({ code: 'too_many' }));
    expect(() => validatePhotos(Array.from({ length: 20 }, () => photo()))).not.toThrow();
  });

  it('accepts JPEG, PNG, WebP and HEIC; refuses the rest and photos over 50 megapixels', () => {
    for (const mimeType of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']) {
      expect(() => validatePhotos([photo({ mimeType })])).not.toThrow();
    }
    expect(() => validatePhotos([photo({ mimeType: null, fileName: 'IMG_1.HEIC' })])).not.toThrow();
    expect(() => validatePhotos([photo(), photo({ mimeType: 'image/gif' })])).toThrow(expect.objectContaining({ code: 'wrong_type', index: 1 }));
    expect(() => validatePhotos([photo({ width: 8160, height: 6144 })])).toThrow(expect.objectContaining({ code: 'too_many_pixels', index: 0 }));
    expect(() => validatePhotos([photo({ width: 0, height: 0 })])).not.toThrow();
  });
});

describe('validateLink and titles', () => {
  it('takes https addresses only, without credentials', () => {
    expect(validateLink(' https://example.com/notes?id=3 ')).toBe('https://example.com/notes?id=3');
    expect(validateLink('https://example.com:8443')).toBe('https://example.com:8443');
    for (const bad of ['http://example.com', 'https://user:pw@example.com/x', 'https://', 'example.com', 'https://exa mple.com', `https://e.com/${'a'.repeat(2048)}`]) {
      expect(() => validateLink(bad)).toThrow(expect.objectContaining({ code: 'bad_link' }));
    }
  });

  it('titles come from the user, else the material; 1 to 200 characters', () => {
    expect(documentTitle('Lecture 3.pdf')).toBe('Lecture 3');
    expect(documentTitle('.pdf')).toBe('Document');
    expect(sourceTitle('  My notes ', 'x')).toBe('My notes');
    expect(sourceTitle('', 'Fallback')).toBe('Fallback');
    expect(sourceTitle(null, 'x'.repeat(300))).toHaveLength(200);
    expect(() => sourceTitle(' ', ' ')).toThrow(expect.objectContaining({ code: 'bad_title' }));
    expect(linkTitle('https://example.com/a/b/')).toBe('example.com/a/b');
    expect(notesTitle(Date.UTC(2026, 9, 9, 12))).toMatch(/^Notes, /);
  });
});

describe('resizeFor (the resize decision)', () => {
  it.each([
    [4032, 3024, { width: 2576 }],
    [3024, 4032, { height: 2576 }],
    [3000, 3000, { width: 2576 }],
    [2577, 100, { width: 2576 }],
    [2576, 1932, null],
    [1000, 800, null],
    [0, 0, null],
    [Number.NaN, 4000, null],
  ])('%p × %p → %p', (width, height, expected) => {
    expect(resizeFor(width, height)).toEqual(expected);
  });
});

describe('storagePath', () => {
  it('is <user>/<source>/<n>.<ext>, as the study function and the database CHECK require', () => {
    const path = storagePath(USER.toUpperCase(), SOURCE, 3, 'jpg');
    expect(path).toBe(`${USER}/${SOURCE}/3.jpg`);
    // supabase/functions/_shared/validate.ts parseFilePath
    expect(path).toMatch(/^([0-9a-f-]{36})\/([0-9a-f-]{36})\/([1-9][0-9]{0,2})\.([a-z]{3,4})$/);
    // source_files_storage_path_in_own_folder (20261009120000_study_engine.sql)
    expect(path).toMatch(new RegExp(`^${USER}/${SOURCE}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`));
    expect(() => storagePath(USER, SOURCE, 0, 'jpg')).toThrow(RangeError);
    expect(() => storagePath(USER, SOURCE, 1000, 'jpg')).toThrow(RangeError);
  });
});

// ---- Picking -------------------------------------------------------------------------------------

describe('picking', () => {
  it('documents: PDF and DOCX, several at once, without the picker’s cache copy', async () => {
    docPicker.getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'content://1', name: 'a.pdf', size: 10, mimeType: 'application/pdf', lastModified: 0 }, { uri: 'content://2', name: 'b.docx', lastModified: 0 }],
    });
    await expect(pickDocuments()).resolves.toEqual([
      { uri: 'content://1', name: 'a.pdf', size: 10, mimeType: 'application/pdf' },
      { uri: 'content://2', name: 'b.docx', size: null, mimeType: null },
    ]);
    expect(docPicker.getDocumentAsync).toHaveBeenCalledWith({
      type: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      multiple: true,
      copyToCacheDirectory: false,
    });
    docPicker.getDocumentAsync.mockResolvedValue({ canceled: true, assets: null });
    await expect(pickDocuments()).resolves.toEqual([]);
  });

  it('photos: original bytes (quality 1), no EXIF, several in order, up to the limit', async () => {
    imagePicker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///p.jpg', width: 4000, height: 3000, fileSize: 5, mimeType: 'image/jpeg', fileName: 'p.jpg' }],
    });
    await expect(pickPhotos(25)).resolves.toEqual([{ uri: 'file:///p.jpg', width: 4000, height: 3000, fileSize: 5, mimeType: 'image/jpeg', fileName: 'p.jpg' }]);
    expect(imagePicker.launchImageLibraryAsync).toHaveBeenCalledWith({
      mediaTypes: ['images'],
      quality: 1,
      exif: false,
      base64: false,
      allowsEditing: false,
      allowsMultipleSelection: true,
      selectionLimit: 20,
      orderedSelection: true,
    });
    imagePicker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });
    await expect(pickPhotos()).resolves.toEqual([]);
  });

  it('the camera: only on Android 10+, asks in context, and reports a refusal or a cancel', async () => {
    expect(canTakePhoto('android', 28)).toBe(false);
    expect(canTakePhoto('android', 29)).toBe(true);
    expect(canTakePhoto('ios', '17.0')).toBe(true);
    expect(canTakePhoto('web', 0)).toBe(false);
    imagePicker.requestCameraPermissionsAsync.mockResolvedValue({ granted: false });
    await expect(takePhoto()).resolves.toBe('denied');
    expect(imagePicker.launchCameraAsync).not.toHaveBeenCalled();
    imagePicker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true });
    imagePicker.launchCameraAsync.mockResolvedValue({ canceled: true, assets: null });
    await expect(takePhoto()).resolves.toBeNull();
    imagePicker.launchCameraAsync.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///c.jpg', width: 0, height: 0 }] });
    await expect(takePhoto()).resolves.toEqual({ uri: 'file:///c.jpg', width: 0, height: 0, fileSize: null, mimeType: null, fileName: null });
  });

  it('recovers a photo taken while Android stopped the app', async () => {
    imagePicker.getPendingResultAsync.mockResolvedValue(null);
    await expect(recoverPendingPhotos()).resolves.toEqual([]);
    imagePicker.getPendingResultAsync.mockResolvedValue({ code: 'E', message: 'failed' });
    await expect(recoverPendingPhotos()).resolves.toEqual([]);
    imagePicker.getPendingResultAsync.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///r.jpg', width: 10, height: 20 }] });
    await expect(recoverPendingPhotos()).resolves.toMatchObject([{ uri: 'file:///r.jpg', width: 10, height: 20 }]);
    imagePicker.getPendingResultAsync.mockRejectedValue(new Error('no module'));
    await expect(recoverPendingPhotos()).resolves.toEqual([]);
  });
});

// ---- Preparing -----------------------------------------------------------------------------------

describe('preparePhoto', () => {
  it('a large photo: shrunk in the same decode, saved as JPEG 0.85, everything released', async () => {
    manipulator.__settings.rendered = [{ width: 2576, height: 1932 }];
    const prepared = await preparePhoto(photo(), USER, SOURCE, 2);
    expect(prepared).toEqual({ uri: 'file:///cache/ImageManipulator/out-1.jpg', path: `${USER}/${SOURCE}/2.jpg`, contentType: 'image/jpeg', size: 900_000, temporary: true });
    expect(manipulator.__log).toEqual([
      ['manipulate', 'file:///cache/ImagePicker/p1.jpg'],
      ['resize', { width: 2576 }],
      ['render', 2576, 1932],
      ['save', 2576, 1932, { format: 'jpeg', compress: 0.85 }],
      ['release image', 2576, 1932],
      ['release context'],
    ]);
  });

  it('a small photo is only re-encoded (never enlarged)', async () => {
    manipulator.__settings.rendered = [{ width: 1600, height: 1200 }];
    await preparePhoto(photo({ width: 1600, height: 1200 }), USER, SOURCE, 1);
    expect(manipulator.__log.filter(([step]) => step === 'resize')).toEqual([]);
  });

  it('an unknown or wrong size is measured after the decode and shrunk in a second step', async () => {
    manipulator.__settings.rendered = [{ width: 3024, height: 4032 }, { width: 1932, height: 2576 }];
    await preparePhoto(photo({ width: 0, height: 0 }), USER, SOURCE, 1);
    expect(manipulator.__log).toEqual([
      ['manipulate', 'file:///cache/ImagePicker/p1.jpg'],
      ['render', 3024, 4032],
      ['manipulate', 'image'],
      ['resize', { height: 2576 }],
      ['render', 1932, 2576],
      ['release image', 3024, 4032],
      ['save', 1932, 2576, { format: 'jpeg', compress: 0.85 }],
      ['release image', 1932, 2576],
      ['release context'],
      ['release context'],
    ]);
  });

  it('a photo that cannot be decoded, or is still too large, is a problem the user can fix', async () => {
    manipulator.__settings.fail = true;
    await expect(preparePhoto(photo(), USER, SOURCE, 3)).rejects.toMatchObject({ code: 'unreadable', index: 2 });
    manipulator.__settings.fail = false;
    manipulator.__settings.savedSize = 26 * MIB;
    await expect(preparePhoto(photo(), USER, SOURCE, 1)).rejects.toMatchObject({ code: 'too_large' });
    expect(fs.deleted).toHaveLength(1);
  });
});

describe('stageDocument', () => {
  it('copies the picked file into the app’s cache, named for its slot', async () => {
    fs.sizes.set('content://docs/42', 2 * MIB);
    const target = validateDocument(doc());
    const staged = await stageDocument(doc(), target, USER, SOURCE);
    expect(fs.created).toEqual([{ uri: `file:///cache/dualrep-uploads/${SOURCE}`, options: { intermediates: true, idempotent: true } }]);
    expect(fs.copies).toEqual([{ from: 'content://docs/42', to: `file:///cache/dualrep-uploads/${SOURCE}/1.pdf`, options: { overwrite: true } }]);
    expect(staged).toEqual({ uri: `file:///cache/dualrep-uploads/${SOURCE}/1.pdf`, path: `${USER}/${SOURCE}/1.pdf`, contentType: 'application/pdf', size: 2 * MIB, temporary: true });
  });

  it('checks the real size after copying, and reports a file that cannot be read', async () => {
    const target = validateDocument(doc({ size: null }));
    fs.sizes.set('content://docs/42', 40 * MIB);
    await expect(stageDocument(doc({ size: null }), target, USER, SOURCE)).rejects.toMatchObject({ code: 'too_large' });
    expect(fs.deleted).toEqual([`file:///cache/dualrep-uploads/${SOURCE}/1.pdf`]);
    fs.sizes.set('content://docs/42', 0);
    await expect(stageDocument(doc(), target, USER, SOURCE)).rejects.toMatchObject({ code: 'empty' });
    fs.copyError = new Error('permission lost');
    await expect(stageDocument(doc(), target, USER, SOURCE)).rejects.toMatchObject({ code: 'unreadable' });
  });
});

// ---- Uploading -----------------------------------------------------------------------------------

describe('uploadFile', () => {
  const small = { uri: 'file:///cache/x/1.jpg', path: `${USER}/${SOURCE}/1.jpg`, contentType: 'image/jpeg', size: 1_000, temporary: true };
  const large = { uri: 'file:///cache/x/1.pdf', path: `${USER}/${SOURCE}/1.pdf`, contentType: 'application/pdf', size: 12 * MIB, temporary: true };

  it('small files: the bytes through supabase-js, with the content type, overwriting', async () => {
    const { context, from, storageUpload } = fakeClient();
    fs.sizes.set(small.uri, 1_000);
    const progress = jest.fn();
    await uploadFile(context, small, { onProgress: progress });
    expect(from).toHaveBeenCalledWith('sources');
    expect(storageUpload).toHaveBeenCalledWith(small.path, expect.any(Uint8Array), { contentType: 'image/jpeg', upsert: true });
    expect((storageUpload.mock.calls[0][1] as Uint8Array).length).toBe(1_000);
    expect(progress).toHaveBeenCalledWith({ bytesSent: 1_000, totalBytes: 1_000 });
  });

  it('small files: Storage errors become the app’s errors', async () => {
    const cases: [unknown, string][] = [
      [{ name: 'StorageUnknownError', message: 'Network request failed' }, 'offline'],
      [{ name: 'StorageApiError', status: 400, statusCode: '413', message: 'The object exceeded the maximum allowed size' }, 'too_large'],
      [{ name: 'StorageApiError', status: 400, statusCode: '415', message: 'mime type image/gif is not supported' }, 'wrong_type'],
      [{ name: 'StorageApiError', status: 401, statusCode: '401', message: 'jwt expired' }, 'signed_out'],
      [{ name: 'StorageApiError', status: 400, statusCode: '403', message: 'new row violates row-level security policy' }, 'forbidden'],
      [{ name: 'StorageApiError', status: 404, statusCode: '404', message: 'Bucket not found' }, 'not_configured'],
      [{ name: 'StorageApiError', status: 500, statusCode: '500', message: 'oops' }, 'server'],
    ];
    for (const [error, expected] of cases) {
      const { context, storageUpload } = fakeClient();
      storageUpload.mockResolvedValueOnce({ data: null, error });
      const caught = await uploadFile(context, small).catch((e: unknown) => e);
      expect(caught instanceof UploadError ? caught.code : (caught as StudyApiError).kind).toBe(expected);
    }
    const { context, storageUpload } = fakeClient();
    storageUpload.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(uploadFile(context, small)).rejects.toMatchObject({ kind: 'offline' });
    fs.bytesError = new Error('gone');
    await expect(uploadFile(context, small)).rejects.toMatchObject({ code: 'unreadable' });
  });

  it('large files: streamed natively to Storage’s REST endpoint with the user’s token', async () => {
    const { context, storageUpload } = fakeClient();
    const progress = jest.fn();
    await uploadFile(context, large, { onProgress: progress });
    expect(storageUpload).not.toHaveBeenCalled();
    expect(fs.uploads).toEqual([
      {
        from: large.uri,
        url: `https://ref.supabase.co/storage/v1/object/sources/${large.path}`,
        options: {
          httpMethod: 'POST',
          headers: { Authorization: 'Bearer jwt-1', apikey: 'sb_publishable_x', 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
          onProgress: progress,
        },
      },
    ]);
  });

  it('large files: failures, a missing session and a lost connection', async () => {
    const { context, getSession } = fakeClient();
    fs.uploadResult = { status: 400, body: JSON.stringify({ statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' }), headers: {} };
    await expect(uploadFile(context, large)).rejects.toMatchObject({ code: 'too_large' });
    fs.uploadResult = { status: 502, body: '<html>bad gateway</html>', headers: {} };
    await expect(uploadFile(context, large)).rejects.toMatchObject({ kind: 'server', status: 502 });
    fs.uploadResult = new Error('unexpected end of stream');
    await expect(uploadFile(context, large)).rejects.toMatchObject({ kind: 'offline' });
    getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    await expect(uploadFile(context, large)).rejects.toMatchObject({ kind: 'signed_out' });
    const controller = new AbortController();
    controller.abort();
    await expect(uploadFile(context, large, { signal: controller.signal })).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('storageFailure reads the real status from the body when Storage wraps it', () => {
    expect(storageFailure(null, null, '')).toMatchObject({ kind: 'offline' });
    expect(storageFailure(400, '413', '')).toBeInstanceOf(UploadError);
    expect(storageFailure(413, null, '')).toMatchObject({ code: 'too_large' });
    expect(storageFailure(400, 'InvalidKey', 'Invalid key')).toMatchObject({ kind: 'server', status: 400 });
  });
});

// ---- The whole flow ------------------------------------------------------------------------------

describe('addMaterial', () => {
  it('notes: prepares every photo, uploads them as 1.jpg, 2.jpg …, submits, and cleans up', async () => {
    const { context, storageUpload, invoke } = fakeClient();
    manipulator.__settings.rendered = [{ width: 2576, height: 1932 }, { width: 1200, height: 900 }];
    const steps: unknown[] = [];
    const result = await addMaterial(context, { kind: 'notes', photos: [photo(), photo({ uri: 'file:///p2.jpg', width: 1200, height: 900 })], title: 'Week 2' }, {
      userId: USER,
      planId: PLAN,
      sourceId: SOURCE.toUpperCase(),
      onProgress: (p) => steps.push(p),
    });
    expect(result).toEqual({ ok: true, source_id: SOURCE, status: 'processing', job_ids: ['j1'], already_submitted: false, sourceId: SOURCE });
    expect(storageUpload.mock.calls.map(([path, , options]) => [path, options])).toEqual([
      [`${USER}/${SOURCE}/1.jpg`, { contentType: 'image/jpeg', upsert: true }],
      [`${USER}/${SOURCE}/2.jpg`, { contentType: 'image/jpeg', upsert: true }],
    ]);
    expect(invoke).toHaveBeenCalledWith('study', {
      body: {
        action: 'submit_source',
        plan_id: PLAN,
        source_id: SOURCE,
        kind: 'notes',
        title: 'Week 2',
        url: null,
        files: [{ path: `${USER}/${SOURCE}/1.jpg` }, { path: `${USER}/${SOURCE}/2.jpg` }],
      },
      timeout: 30_000,
    });
    expect(steps).toEqual([
      { phase: 'preparing', done: 0, total: 2 },
      { phase: 'preparing', done: 1, total: 2 },
      { phase: 'uploading', done: 0, total: 2 },
      { phase: 'uploading', done: 0, total: 2, bytesSent: 900_000, totalBytes: 900_000 },
      { phase: 'uploading', done: 1, total: 2 },
      { phase: 'uploading', done: 1, total: 2, bytesSent: 900_000, totalBytes: 900_000 },
      { phase: 'submitting', done: 0, total: 1 },
      { phase: 'done', done: 1, total: 1 },
    ]);
    expect(fs.deleted).toEqual([expect.stringMatching(/^file:\/\/\/cache\/ImageManipulator\/out-\d+\.jpg$/), expect.stringMatching(/out-\d+\.jpg$/)]);
    expect(new Set(fs.deleted).size).toBe(2);
  });

  it('a PDF: staged, uploaded as 1.pdf, submitted with its file name as the title and a new source id', async () => {
    const { context, invoke } = fakeClient();
    fs.sizes.set('content://docs/42', 2 * MIB);
    const result = await addMaterial(context, { kind: 'pdf', document: doc() }, { userId: USER, planId: PLAN });
    const sent = (invoke.mock.calls[0][1] as { body: Record<string, unknown> }).body;
    expect(result.sourceId).toBe(result.source_id);
    expect(result.sourceId).toMatch(/^a0000000-0000-4000-8000-00000000000\d$/);
    expect(sent).toMatchObject({ kind: 'pdf', title: 'Lecture 3', url: null, files: [{ path: `${USER}/${result.sourceId}/1.pdf` }] });
    expect(fs.deleted).toEqual([`file:///cache/dualrep-uploads/${result.sourceId}/1.pdf`]);
  });

  it('a link: nothing to upload, just the submit', async () => {
    const { context, storageUpload, invoke } = fakeClient();
    await addMaterial(context, { kind: 'link', url: 'https://example.com/article' }, { userId: USER, planId: PLAN, sourceId: SOURCE });
    expect(storageUpload).not.toHaveBeenCalled();
    expect((invoke.mock.calls[0][1] as { body: unknown }).body).toEqual({
      action: 'submit_source',
      plan_id: PLAN,
      source_id: SOURCE,
      kind: 'link',
      title: 'example.com/article',
      url: 'https://example.com/article',
      files: [],
    });
  });

  it('stops at the first failure, submits nothing, and still deletes the prepared copies', async () => {
    const { context, storageUpload, invoke } = fakeClient();
    storageUpload.mockResolvedValueOnce({ data: null, error: { name: 'StorageUnknownError', message: 'Network request failed' } });
    await expect(addMaterial(context, { kind: 'notes', photos: [photo(), photo()] }, { userId: USER, planId: PLAN, sourceId: SOURCE })).rejects.toMatchObject({
      kind: 'offline',
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(fs.deleted).toHaveLength(2);
  });

  it('invalid material is refused before anything happens; a cancel stops it', async () => {
    const { context, storageUpload, invoke } = fakeClient();
    await expect(addMaterial(context, { kind: 'notes', photos: [] }, { userId: USER, planId: PLAN })).rejects.toMatchObject({ code: 'no_files' });
    await expect(addMaterial(context, { kind: 'link', url: 'ftp://x' }, { userId: USER, planId: PLAN })).rejects.toMatchObject({ code: 'bad_link' });
    const controller = new AbortController();
    controller.abort();
    await expect(addMaterial(context, { kind: 'notes', photos: [photo()] }, { userId: USER, planId: PLAN, signal: controller.signal })).rejects.toMatchObject({
      kind: 'cancelled',
    });
    expect(storageUpload).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    await expect(addMaterial(null, { kind: 'link', url: 'https://e.com' }, { userId: USER, planId: PLAN })).rejects.toMatchObject({ kind: 'not_configured' });
  });

  it('waits for the phone’s writes, then asks again while the server cannot find a plan made offline', async () => {
    const { context, invoke } = fakeClient();
    const { FunctionsHttpError } = jest.requireActual<typeof import('@supabase/functions-js')>('@supabase/functions-js');
    const notFound = () =>
      ({ data: null, error: new FunctionsHttpError({ status: 404, json: async () => ({ ok: false, code: 'not_found', error: 'This plan isn’t on the server yet.' }) }) }) as never;
    invoke.mockResolvedValueOnce(notFound()).mockResolvedValueOnce(notFound());
    const order: string[] = [];
    const sleeps: number[] = [];
    const result = await addMaterial(context, { kind: 'link', url: 'https://e.com' }, {
      userId: USER,
      planId: PLAN,
      sourceId: SOURCE,
      beforeSubmit: async () => {
        order.push('waited for uploads');
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(order).toEqual(['waited for uploads']);
    expect(sleeps).toEqual([2_000, 4_000]);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(result.sourceId).toBe(SOURCE);

    // It gives up after the last delay with the server's own words; other errors are not retried.
    invoke.mockClear();
    invoke.mockResolvedValue(notFound());
    const caught = await addMaterial(context, { kind: 'link', url: 'https://e.com' }, { userId: USER, planId: PLAN, sleep: async () => undefined }).catch(
      (e: unknown) => e,
    );
    expect(caught).toMatchObject({ kind: 'not_found' });
    expect(invoke).toHaveBeenCalledTimes(1 + SUBMIT_RETRY_DELAYS_MS.length);
    expect(uploadErrorMessage(caught)).toBe('This plan isn’t on the server yet.');
  });

  it('a cap reached at submit comes back as the typed error', async () => {
    const { context, invoke } = fakeClient();
    const { FunctionsHttpError } = jest.requireActual<typeof import('@supabase/functions-js')>('@supabase/functions-js');
    const response = { status: 429, json: async () => ({ ok: false, code: 'cap_reached', error: 'x', stage: 'extract', used: 5, limit: 5, resets_at: '2026-11-01T00:00:00.000Z' }) };
    invoke.mockResolvedValueOnce({ data: null, error: new FunctionsHttpError(response) } as never);
    const caught = await addMaterial(context, { kind: 'link', url: 'https://e.com' }, { userId: USER, planId: PLAN }).catch((e: unknown) => e);
    expect(caught).toMatchObject({ kind: 'cap_reached', cap: { stage: 'extract', used: 5, limit: 5 } });
    expect(uploadErrorMessage(caught)).toMatch(/^You’ve used all 5 sources for this month\./);
  });
});

describe('uploadContextFor and messages', () => {
  it('the app’s Supabase client fits the upload’s client type (checked by tsc)', () => {
    const asUploadClient = (client: SupabaseClient): UploadClient => client;
    expect(typeof asUploadClient).toBe('function');
  });

  it('builds the context from the app’s configuration', () => {
    const { context } = fakeClient();
    expect(uploadContextFor(context.client)).toEqual({ client: context.client, supabaseUrl: 'https://ref.supabase.co', publishableKey: 'sb_publishable_x' });
    expect(uploadContextFor(null)).toBeNull();
    env.readEnv.mockReturnValueOnce({ ok: false, missing: [], invalid: [], reasons: {} });
    expect(uploadContextFor(context.client)).toBeNull();
  });

  it('says what went wrong', () => {
    expect(uploadErrorMessage(new UploadError('too_large', 'Too big.'))).toBe('Too big.');
    expect(uploadErrorMessage(new StudyApiError('offline'))).toMatch(/^No internet connection/);
    expect(uploadErrorMessage('x')).toBe('Something went wrong. Try again.');
    expect(UPLOAD_RULES).toMatchObject({ maxFileBytes: 25 * MIB, maxPhotos: 20, longEdge: 2576, jpegQuality: 0.85 });
  });
});
