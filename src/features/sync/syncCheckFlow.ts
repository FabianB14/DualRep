import type { ServerCheckResult } from '@/db/syncCheck';

/**
 * The Phase 0 gate as a small state machine: a row created with airplane mode on must show up in
 * Postgres after airplane mode is turned off. Pure, so the step logic is unit-tested and the screen
 * only renders the current step and its one primary action.
 */

export type StepId = 'airplane-on' | 'create-row' | 'airplane-off' | 'wait-upload' | 'check-server';

export const STEPS: readonly { id: StepId; title: string }[] = [
  { id: 'airplane-on', title: 'Turn on airplane mode' },
  { id: 'create-row', title: 'Create a test row' },
  { id: 'airplane-off', title: 'Turn airplane mode off' },
  { id: 'wait-upload', title: 'Wait for the upload' },
  { id: 'check-server', title: 'Check Postgres' },
];

export type Probe = { id: string; createdAt: string };

export type SyncCheckState = {
  /** The current step, or 'passed' once the row was found in Postgres. */
  step: StepId | 'passed';
  probe: Probe | null;
  busy: boolean;
  /** Result of the latest server check (shown until the next one). */
  result: ServerCheckResult | null;
  /** Plain-words problem with the latest action, if any. */
  error: string | null;
};

export type SyncCheckAction =
  | { type: 'airplane-on-confirmed' }
  | { type: 'create-started' }
  | { type: 'create-succeeded'; probe: Probe }
  | { type: 'create-failed'; message: string }
  | { type: 'airplane-off-confirmed' }
  | { type: 'queue-count'; count: number | null }
  | { type: 'check-started' }
  | { type: 'check-finished'; result: ServerCheckResult }
  | { type: 'restart' };

export const initialSyncCheckState: SyncCheckState = {
  step: 'airplane-on',
  probe: null,
  busy: false,
  result: null,
  error: null,
};

export function syncCheckReducer(state: SyncCheckState, action: SyncCheckAction): SyncCheckState {
  switch (action.type) {
    case 'airplane-on-confirmed':
      return state.step === 'airplane-on' ? { ...state, step: 'create-row', error: null } : state;
    case 'create-started':
      return state.step === 'create-row' ? { ...state, busy: true, error: null } : state;
    case 'create-succeeded':
      return { ...state, step: 'airplane-off', probe: action.probe, busy: false, error: null };
    case 'create-failed':
      return { ...state, busy: false, error: action.message };
    case 'airplane-off-confirmed':
      return state.step === 'airplane-off' ? { ...state, step: 'wait-upload', error: null } : state;
    case 'queue-count':
      // Everything the phone queued has been accepted (or rejected and logged) by the server.
      return state.step === 'wait-upload' && action.count === 0 ? { ...state, step: 'check-server' } : state;
    case 'check-started':
      return state.step === 'check-server' ? { ...state, busy: true, error: null, result: null } : state;
    case 'check-finished':
      return {
        ...state,
        busy: false,
        result: action.result,
        step: action.result === 'found' ? 'passed' : state.step,
      };
    case 'restart':
      return initialSyncCheckState;
  }
}

export function stepIndex(step: SyncCheckState['step']): number {
  return step === 'passed' ? STEPS.length : STEPS.findIndex((s) => s.id === step);
}

/** What the latest server check means, in plain words. */
export function describeCheckResult(result: ServerCheckResult): { tone: 'success' | 'warning' | 'danger'; text: string } {
  switch (result) {
    case 'found':
      return { tone: 'success', text: 'PASS — the row made offline is in Postgres.' };
    case 'missing':
      return {
        tone: 'warning',
        text: 'Not in Postgres yet. If “Waiting to upload” is 0, look for an upload problem below, then check again.',
      };
    case 'offline':
      return { tone: 'warning', text: 'No connection. Make sure airplane mode is off, then check again.' };
    case 'error':
      return { tone: 'danger', text: 'The server could not be asked. Check the Supabase settings, then try again.' };
  }
}
