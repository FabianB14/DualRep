import { assert, assertEquals } from 'jsr:@std/assert@1.0.13';
import { checkStudyRequest, isUsableLink, parseFilePath } from './validate.ts';

const U = '11111111-1111-4111-8111-111111111111';
const P = '50000000-0000-4000-8000-000000000001';
const S = '70000000-0000-4000-8000-000000000001';
const T = '60000000-0000-4000-8000-000000000001';

const submit = (extra: Record<string, unknown>) => checkStudyRequest({ action: 'submit_source', plan_id: P, source_id: S, title: 'Lecture 3', ...extra }, U);
const errorsOf = (r: ReturnType<typeof checkStudyRequest>) => (r.ok ? [] : r.errors);

Deno.test('submit_source: a PDF, a document, a link and notes', () => {
  const pdf = submit({ kind: 'pdf', files: [{ path: `${U}/${S}/1.pdf` }] });
  assertEquals(pdf, {
    ok: true,
    value: { action: 'submit_source', plan_id: P, source_id: S, kind: 'pdf', title: 'Lecture 3', url: null, files: [{ path: `${U}/${S}/1.pdf` }] },
  });
  assert(submit({ kind: 'doc', files: [{ path: `${U}/${S}/1.docx` }] }).ok);
  assert(submit({ kind: 'link', url: 'https://example.org/notes', files: [] }).ok);
  assert(submit({ kind: 'notes', files: [1, 2, 3].map((n) => ({ path: `${U}/${S}/${n}.jpg` })) }).ok);
});

Deno.test('submit_source: refuses wrong counts, foreign folders, bad names and stray urls', () => {
  assertEquals(errorsOf(submit({ kind: 'pdf', files: [] })), ['files must have exactly 1 entry for kind pdf']);
  assertEquals(errorsOf(submit({ kind: 'pdf', files: [{ path: `22222222-2222-4222-8222-222222222222/${S}/1.pdf` }] })).length, 1);
  assertEquals(errorsOf(submit({ kind: 'pdf', files: [{ path: `${U}/${S}/1.docx` }] })).length, 1);
  assertEquals(errorsOf(submit({ kind: 'pdf', files: [{ path: `${U}/${S}/../1.pdf` }] })).length, 1);
  assertEquals(
    errorsOf(submit({ kind: 'notes', files: [{ path: `${U}/${S}/1.jpg` }, { path: `${U}/${S}/1.png` }] })),
    ['files[1].path repeats file number 1'],
  );
  assertEquals(errorsOf(submit({ kind: 'notes', files: Array.from({ length: 21 }, (_, i) => ({ path: `${U}/${S}/${i + 1}.jpg` })) }))[0], 'files must have 1 to 20 entries for kind notes');
  assertEquals(errorsOf(submit({ kind: 'link', url: 'http://example.org', files: [] })).length, 1);
  assertEquals(errorsOf(submit({ kind: 'pdf', url: 'https://example.org', files: [{ path: `${U}/${S}/1.pdf` }] })), ['url is only for kind link']);
  assertEquals(errorsOf(submit({ kind: 'pdf', title: '   ', files: [{ path: `${U}/${S}/1.pdf` }] })), ['title must be 1 to 200 characters']);
  assertEquals(errorsOf(submit({ kind: 'video', files: [] })).length, 1);
});

Deno.test('error messages name fields, never the values sent', () => {
  const secret = 'SECRET-NOTES-TEXT';
  const all = [
    ...errorsOf(submit({ kind: 'pdf', title: secret.repeat(50), files: [{ path: secret }] })),
    ...errorsOf(checkStudyRequest({ action: 'confirm_transcripts', plan_id: P, source_id: S, files: [{ id: secret, transcript: secret.repeat(2000) }] }, U)),
    ...errorsOf(checkStudyRequest({ action: 'approve_outline', plan_id: P, topics: [{ id: secret, keep: 'yes', title: secret.repeat(20) }] }, U)),
  ];
  assert(all.length >= 5);
  assert(all.every((e) => !e.includes(secret)), all.join('\n'));
});

Deno.test('confirm_transcripts, approve_outline, retry_job and cancel_job', () => {
  assertEquals(checkStudyRequest({ action: 'confirm_transcripts', plan_id: P, source_id: S }, U), {
    ok: true,
    value: { action: 'confirm_transcripts', plan_id: P, source_id: S, files: [] },
  });
  assertEquals(errorsOf(checkStudyRequest({ action: 'confirm_transcripts', plan_id: P, source_id: S, files: [{ id: T, transcript: 'a' }, { id: T, transcript: 'b' }] }, U)), ['files[1].id is listed twice']);
  assertEquals(checkStudyRequest({ action: 'approve_outline', plan_id: P, topics: [{ id: T, keep: true, title: ' New ' }, { id: S, keep: false }] }, U), {
    ok: true,
    value: { action: 'approve_outline', plan_id: P, source_id: null, topics: [{ id: T, keep: true, title: 'New' }, { id: S, keep: false }] },
  });
  assertEquals(errorsOf(checkStudyRequest({ action: 'approve_outline', plan_id: P, source_id: 'x', topics: [] }, U)), ['source_id must be a uuid or null']);
  assertEquals(checkStudyRequest({ action: 'retry_job', job_id: T }, U), { ok: true, value: { action: 'retry_job', job_id: T } });
  assertEquals(errorsOf(checkStudyRequest({ action: 'cancel_job' }, U)), ['job_id must be a uuid']);
  assertEquals(errorsOf(checkStudyRequest({ action: 'delete_everything' }, U)).length, 1);
  assertEquals(errorsOf(checkStudyRequest([1, 2], U)), ['the body must be a JSON object']);
});

Deno.test('parseFilePath and isUsableLink', () => {
  assertEquals(parseFilePath(`${U}/${S}/12.jpeg`, U, S, 'notes'), { path: `${U}/${S}/12.jpeg`, n: 12, ext: 'jpeg', mime: 'image/jpeg' });
  assertEquals(parseFilePath(`${U}/${S}/0.jpg`, U, S, 'notes'), null);
  assertEquals(parseFilePath(`${U}/${S}/1.jpg`, U, S, 'pdf'), null);
  assert(isUsableLink('https://en.wikipedia.org/wiki/Cell_(biology)'));
  assert(!isUsableLink('https://user:pw@example.org/'));
  assert(!isUsableLink('ftp://example.org/'));
  assert(!isUsableLink('not a url'));
});
