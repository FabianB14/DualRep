import { describe, expect, it } from '@jest/globals';

import {
  ALL_SKIPPED_MESSAGE,
  describeStep,
  GENERIC_ERROR,
  planNextStep,
  sourceNote,
  sourceStep,
  STOPPED_MESSAGE,
  type ProgressFile,
  type ProgressJob,
  type ProgressSource,
} from '../sourceProgress';

const pdf: ProgressSource = { id: 's1', kind: 'pdf', status: 'processing', title: 'Lecture 1' };
const notes: ProgressSource = { id: 's2', kind: 'notes', status: 'processing', title: 'Notes' };
let seq = 0;
const job = (stage: string, status: string, extra: Partial<ProgressJob> = {}): ProgressJob => ({
  id: `j${(seq += 1)}`,
  stage,
  status,
  error: null,
  createdAt: seq,
  ...extra,
});
const file = (id: string, transcript: string | null, confirmed = false): ProgressFile => ({ id, transcript, confirmed });

describe('sourceStep', () => {
  it('a new source with no job yet is waiting', () => {
    expect(sourceStep({ ...pdf, status: 'pending' }, [], [], 0)).toEqual({ step: 'waiting' });
  });

  it('a document being extracted, then outlined, then reviewed, then carded, then ready', () => {
    const extract = job('extract', 'running');
    expect(sourceStep(pdf, [], [extract], 0)).toEqual({ step: 'reading', done: 0, total: 0 });
    const done = { ...extract, status: 'succeeded' };
    const outline = job('outline', 'queued');
    expect(sourceStep(pdf, [], [done, outline], 0)).toEqual({ step: 'outlining' });
    const outlined = { ...outline, status: 'succeeded' };
    expect(sourceStep(pdf, [], [done, outlined], 4)).toEqual({ step: 'review_outline', draftTopics: 4 });
    const cards = [job('cards', 'succeeded'), job('cards', 'running'), job('cards', 'queued')];
    expect(sourceStep(pdf, [], [done, outlined, ...cards], 0)).toEqual({ step: 'making_cards', done: 1, total: 3 });
    const allDone = cards.map((c) => ({ ...c, status: 'succeeded' }));
    expect(sourceStep(pdf, [], [done, outlined, ...allDone], 0)).toEqual({ step: 'ready' });
    expect(sourceStep({ ...pdf, status: 'ready' }, [], [done, outlined, ...allDone], 0)).toEqual({ step: 'ready' });
  });

  it('notes: photos being read, then checked by the user', () => {
    const files = [file('f1', 'one'), file('f2', null), file('f3', null)];
    const jobs = [job('transcribe', 'succeeded'), job('transcribe', 'running'), job('transcribe', 'queued')];
    expect(sourceStep(notes, files, jobs, 0)).toEqual({ step: 'reading', done: 1, total: 3 });
    const transcribed = [file('f1', 'one', true), file('f2', 'two'), file('f3', 'three')];
    const finished = jobs.map((j) => ({ ...j, status: 'succeeded' }));
    expect(sourceStep(notes, transcribed, finished, 0)).toEqual({ step: 'check_transcripts', unconfirmed: 2 });
    const confirmed = transcribed.map((f) => ({ ...f, confirmed: true }));
    expect(sourceStep(notes, confirmed, [...finished, job('outline', 'queued')], 0)).toEqual({ step: 'outlining' });
  });

  it('notes whose transcripts have not synced yet are still being read', () => {
    expect(sourceStep(notes, [file('f1', null), file('f2', 'two')], [job('transcribe', 'succeeded')], 0)).toEqual({
      step: 'reading',
      done: 1,
      total: 2,
    });
  });

  it('a failed job shows its error with Try again, until a later job of its stage moves on', () => {
    const failed = job('extract', 'failed', { error: 'This PDF is password-protected.' });
    expect(sourceStep(pdf, [], [failed], 0)).toEqual({ step: 'failed', message: 'This PDF is password-protected.', jobId: failed.id, canSkip: false });
    expect(sourceStep(pdf, [], [failed, job('extract', 'running')], 0)).toEqual({ step: 'reading', done: 0, total: 0 });
    const noText = job('cards', 'failed', { error: '  ' });
    expect(sourceStep(pdf, [], [job('outline', 'succeeded'), noText], 0)).toEqual({ step: 'failed', message: GENERIC_ERROR, jobId: noText.id, canSkip: false });
  });

  it('ignores embedding and cancelled jobs', () => {
    const jobs = [job('extract', 'succeeded'), job('embed', 'failed'), job('outline', 'cancelled'), job('outline', 'running')];
    expect(sourceStep(pdf, [], jobs, 0)).toEqual({ step: 'outlining' });
  });

  it('a failed source with no job left says it could not finish', () => {
    expect(sourceStep({ ...pdf, status: 'failed' }, [], [], 0)).toEqual({ step: 'failed', message: GENERIC_ERROR, jobId: null, canSkip: false });
  });

  it('a stopped source (its extraction cancelled) offers Try again on that job', () => {
    const stopped = job('extract', 'cancelled');
    expect(sourceStep({ ...pdf, status: 'failed' }, [], [stopped], 0)).toEqual({ step: 'failed', message: STOPPED_MESSAGE, jobId: stopped.id, canSkip: false });
  });

  it('a page that could not be read can be retried or skipped; a skipped page no longer holds the notes up', () => {
    const files = [file('f1', 'one'), file('f2', null), file('f3', 'three')];
    const bad = job('transcribe', 'failed', { error: 'This page couldn’t be read.' });
    const jobs = [job('transcribe', 'succeeded'), bad, job('transcribe', 'succeeded')];
    expect(sourceStep(notes, files, jobs, 0)).toEqual({ step: 'failed', message: 'This page couldn’t be read.', jobId: bad.id, canSkip: true });
    const skipped = jobs.map((j) => (j === bad ? { ...j, status: 'cancelled' } : j));
    expect(sourceStep(notes, files, skipped, 0)).toEqual({ step: 'check_transcripts', unconfirmed: 2 });
    const stillReading = [job('transcribe', 'succeeded'), { ...bad, status: 'cancelled' }, job('transcribe', 'running')];
    expect(sourceStep(notes, files, stillReading, 0)).toEqual({ step: 'reading', done: 2, total: 3 });
  });

  it('a failed cards job stands until it is retried, whatever another topic’s cards job did', () => {
    // Cards jobs are one (or more) per topic: topic 2's failure must not hide behind topic 3's success,
    // whichever was queued first, even once the source is ready.
    const ready = { ...pdf, status: 'ready' };
    const base = [job('extract', 'succeeded'), job('outline', 'succeeded')];
    const failedFirst = job('cards', 'failed', { error: 'Tracy declined to work on this material.' });
    const laterOk = job('cards', 'succeeded');
    const expected = { step: 'failed', message: 'Tracy declined to work on this material.', jobId: failedFirst.id, canSkip: false };
    expect(sourceStep(ready, [], [...base, failedFirst, laterOk], 0)).toEqual(expected);
    expect(sourceStep(pdf, [], [...base, failedFirst, laterOk, job('cards', 'running')], 0)).toEqual(expected);
    expect(planNextStep([{ sourceId: 's1', step: sourceStep(ready, [], [...base, failedFirst, laterOk], 0) }], 5)).toMatchObject({ kind: 'retry', jobId: failedFirst.id });
    // Retried: the same row is queued again and the cards are being made.
    expect(sourceStep(pdf, [], [...base, { ...failedFirst, status: 'queued' }, laterOk], 0)).toEqual({ step: 'making_cards', done: 1, total: 2 });
  });

  it('notes whose every page was skipped are not "being read" for ever: Try again on the last page', () => {
    const one = job('transcribe', 'failed', { error: 'Tracy didn’t answer in time. Try again.' });
    // The only page: it can be tried again, not skipped (that would leave nothing).
    expect(sourceStep(notes, [file('f1', null)], [one], 0)).toEqual({ step: 'failed', message: 'Tracy didn’t answer in time. Try again.', jobId: one.id, canSkip: false });
    // Skipped anyway (e.g. on another phone): a failure with Try again, never "Reading your material".
    const skipped = { ...one, status: 'cancelled' };
    const step = sourceStep(notes, [file('f1', null)], [skipped], 0);
    expect(step).toEqual({ step: 'failed', message: ALL_SKIPPED_MESSAGE, jobId: one.id, canSkip: false });
    expect(planNextStep([{ sourceId: 's2', step }], 0)).toMatchObject({ kind: 'retry', jobId: one.id });
    // Two pages, both failed: the first can be skipped, the second (the last one left) cannot.
    const a = job('transcribe', 'failed');
    const b = job('transcribe', 'failed');
    expect(sourceStep(notes, [file('f1', null), file('f2', null)], [a, b], 0)).toMatchObject({ jobId: b.id, canSkip: true });
    expect(sourceStep(notes, [file('f1', null), file('f2', null)], [{ ...a, status: 'cancelled' }, b], 0)).toMatchObject({ jobId: b.id, canSkip: false });
    // A scanned PDF's pages can always be skipped: its text stays.
    const scan = job('transcribe', 'failed');
    expect(sourceStep(pdf, [], [job('extract', 'succeeded'), scan], 0)).toMatchObject({ jobId: scan.id, canSkip: true });
  });

  it('keeps the pipeline’s note on a finished step', () => {
    expect(sourceNote([job('extract', 'succeeded', { error: '3 scanned pages were skipped: this month’s page limit is used up.' }), job('outline', 'succeeded')])).toBe(
      '3 scanned pages were skipped: this month’s page limit is used up.',
    );
    expect(sourceNote([job('extract', 'failed', { error: 'x' }), job('outline', 'succeeded', { error: '  ' })])).toBeNull();
  });

  it('accepts ISO times for ordering', () => {
    const failed = job('extract', 'failed', { createdAt: '2026-10-09T10:00:00.000Z' });
    const retried = job('extract', 'queued', { createdAt: '2026-10-09T10:05:00.000Z' });
    expect(sourceStep(pdf, [], [retried, failed], 0).step).toBe('reading');
  });
});

describe('describeStep', () => {
  it('words each step and names its action', () => {
    expect(describeStep({ step: 'failed', message: 'Nope', jobId: 'j', canSkip: false })).toEqual({ title: 'Couldn’t finish', detail: 'Nope', action: 'retry', tone: 'danger' });
    expect(describeStep({ step: 'failed', message: 'Nope', jobId: null, canSkip: false }).action).toBeNull();
    expect(describeStep({ step: 'reading', done: 2, total: 5 }).detail).toBe('2 of 5 done');
    expect(describeStep({ step: 'reading', done: 0, total: 0 }).detail).toBeNull();
    expect(describeStep({ step: 'check_transcripts', unconfirmed: 1 })).toMatchObject({ detail: '1 page to check', action: 'check_transcripts' });
    expect(describeStep({ step: 'check_transcripts', unconfirmed: 3 }).detail).toBe('3 pages to check');
    expect(describeStep({ step: 'review_outline', draftTopics: 0 })).toMatchObject({ title: 'Review the outline', detail: null });
    expect(describeStep({ step: 'review_outline', draftTopics: 1 }).detail).toBe('1 new topic');
    expect(describeStep({ step: 'making_cards', done: 2, total: 6 }).title).toBe('Making cards (2 of 6)');
    expect(describeStep({ step: 'outlining' }).title).toBe('Making the outline');
    expect(describeStep({ step: 'waiting' }).title).toBe('Waiting to start');
    expect(describeStep({ step: 'ready' }).tone).toBe('success');
  });
});

describe('planNextStep', () => {
  it('asks the user first, then studies, then waits, else adds material', () => {
    const working = { sourceId: 'a', step: { step: 'making_cards', done: 1, total: 3 } as const };
    const check = { sourceId: 'b', step: { step: 'check_transcripts', unconfirmed: 2 } as const };
    const review = { sourceId: 'c', step: { step: 'review_outline', draftTopics: 3 } as const };
    const failed = { sourceId: 'd', step: { step: 'failed', message: 'x', jobId: 'j', canSkip: true } as const };
    const ready = { sourceId: 'e', step: { step: 'ready' } as const };
    expect(planNextStep([working, failed, review, check], 10)).toEqual({ kind: 'check_transcripts', sourceId: 'b', unconfirmed: 2 });
    expect(planNextStep([working, failed, review], 10)).toEqual({ kind: 'review_outline', sourceId: 'c' });
    expect(planNextStep([working, failed], 10)).toEqual({ kind: 'retry', sourceId: 'd', jobId: 'j', message: 'x', canSkip: true });
    expect(planNextStep([working, ready], 10)).toEqual({ kind: 'study' });
    expect(planNextStep([ready, working], 0)).toEqual({ kind: 'working', sourceId: 'a' });
    expect(planNextStep([], 0)).toEqual({ kind: 'add_material' });
    expect(planNextStep([ready], 0)).toEqual({ kind: 'add_material' });
  });
});
