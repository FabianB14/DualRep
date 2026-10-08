import { describe, expect, it } from '@jest/globals';

import {
  describeCheckResult,
  initialSyncCheckState,
  stepIndex,
  STEPS,
  syncCheckReducer,
  type SyncCheckAction,
  type SyncCheckState,
} from '../syncCheckFlow';
import { describeActivity, formatSince, summarizeSync, type SyncSnapshot } from '../syncStatus';

const run = (actions: SyncCheckAction[], from: SyncCheckState = initialSyncCheckState) =>
  actions.reduce(syncCheckReducer, from);

const probe = { id: '7d3f0f8e-0000-4000-8000-000000000001', createdAt: '2026-10-08T12:00:00.000Z' };

describe('sync check flow', () => {
  it('walks the happy path to PASS', () => {
    const state = run([
      { type: 'airplane-on-confirmed' },
      { type: 'create-started' },
      { type: 'create-succeeded', probe },
      { type: 'airplane-off-confirmed' },
      { type: 'queue-count', count: 2 },
      { type: 'queue-count', count: 0 },
      { type: 'check-started' },
      { type: 'check-finished', result: 'found', streamConnected: true },
    ]);
    expect(state).toEqual({ step: 'passed', probe, busy: false, result: 'found', error: null });
    expect(stepIndex(state.step)).toBe(STEPS.length);
  });

  it('waits on the upload step until the queue is empty', () => {
    const waiting = run([
      { type: 'airplane-on-confirmed' },
      { type: 'create-succeeded', probe },
      { type: 'airplane-off-confirmed' },
      { type: 'queue-count', count: null },
      { type: 'queue-count', count: 1 },
    ]);
    expect(waiting.step).toBe('wait-upload');
    expect(syncCheckReducer(waiting, { type: 'queue-count', count: 0 }).step).toBe('check-server');
  });

  it('ignores the queue count before airplane mode is off (the queue is expected to be full)', () => {
    const state = run([{ type: 'airplane-on-confirmed' }, { type: 'create-succeeded', probe }, { type: 'queue-count', count: 0 }]);
    expect(state.step).toBe('airplane-off');
  });

  it('stays on the check step with the result when the row is not found', () => {
    const atCheck: SyncCheckState = { ...initialSyncCheckState, step: 'check-server', probe };
    for (const result of ['missing', 'offline', 'error'] as const) {
      const state = run([{ type: 'check-started' }, { type: 'check-finished', result, streamConnected: true }], atCheck);
      expect(state).toMatchObject({ step: 'check-server', result, busy: false });
    }
  });

  it('does not pass when the row is in Postgres but the PowerSync stream is down', () => {
    const atCheck: SyncCheckState = { ...initialSyncCheckState, step: 'check-server', probe };
    const state = run([{ type: 'check-started' }, { type: 'check-finished', result: 'found', streamConnected: false }], atCheck);
    expect(state).toMatchObject({ step: 'check-server', result: 'found-no-stream', busy: false });
    expect(describeCheckResult('found-no-stream')).toMatchObject({ tone: 'warning', text: expect.stringContaining('PowerSync') });
  });

  it('keeps the step and reports the problem when creating the row fails', () => {
    const state = run([
      { type: 'airplane-on-confirmed' },
      { type: 'create-started' },
      { type: 'create-failed', message: 'disk full' },
    ]);
    expect(state).toMatchObject({ step: 'create-row', busy: false, error: 'disk full' });
  });

  it('ignores actions that belong to another step', () => {
    expect(syncCheckReducer(initialSyncCheckState, { type: 'airplane-off-confirmed' })).toBe(initialSyncCheckState);
    expect(syncCheckReducer(initialSyncCheckState, { type: 'check-started' })).toBe(initialSyncCheckState);
  });

  it('restarts from the beginning', () => {
    const passed: SyncCheckState = { step: 'passed', probe, busy: false, result: 'found', error: null };
    expect(syncCheckReducer(passed, { type: 'restart' })).toEqual(initialSyncCheckState);
  });

  it('describes every server result in plain words', () => {
    expect(describeCheckResult('found')).toEqual({ tone: 'success', text: expect.stringContaining('PASS') });
    expect(describeCheckResult('missing').tone).toBe('warning');
    expect(describeCheckResult('offline').text).toMatch(/airplane mode is off/);
    expect(describeCheckResult('error').tone).toBe('danger');
  });
});

describe('sync status wording', () => {
  const base: SyncSnapshot = {
    connected: false,
    connecting: false,
    uploading: false,
    downloading: false,
    pendingUploads: 0,
  };

  it.each<[Partial<SyncSnapshot>, string]>([
    [{ connected: true }, 'Up to date'],
    [{ connected: true, uploading: true }, 'Uploading'],
    [{ connected: true, downloading: true }, 'Downloading'],
    [{ connected: true, pendingUploads: 3 }, 'Uploading soon'],
    [{ connecting: true }, 'Connecting'],
    [{}, 'Offline'],
    [{ offlineSession: true }, 'Offline'],
    [{ connected: true, uploadError: new Error('500') }, 'Upload problem'],
  ])('%p → %s', (patch, label) => {
    expect(summarizeSync({ ...base, ...patch }).label).toBe(label);
  });

  it('formats time since the last sync', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    expect(formatSince(undefined, now)).toBe('never');
    expect(formatSince(ago(3_000), now)).toBe('just now');
    expect(formatSince(ago(45_000), now)).toBe('45 s ago');
    expect(formatSince(ago(3 * 60_000), now)).toBe('3 min ago');
    expect(formatSince(ago(2 * 3_600_000), now)).toBe('2 h ago');
    expect(formatSince(ago(26 * 3_600_000), now)).toBe('1 day ago');
    expect(formatSince(ago(4 * 86_400_000), now)).toBe('4 days ago');
    // A clock that moved backwards never shows a negative time.
    expect(formatSince(new Date(now.getTime() + 5_000), now)).toBe('just now');
  });

  it('describes upload/download activity', () => {
    expect(describeActivity({ uploading: false, downloading: false })).toBe('Idle');
    expect(describeActivity({ uploading: true, downloading: true })).toBe('Uploading and downloading');
  });
});
