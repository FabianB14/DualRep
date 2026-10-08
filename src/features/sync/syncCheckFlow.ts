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

/**
 * The test row. Only ever created after the screen confirmed the server was unreachable, so a PASS
 * really means "written offline, uploaded later" (Android can keep Wi-Fi on in airplane mode).
 */
export type Probe = { id: string; createdAt: string };

/**
 * Result of a server check. 'found-no-stream' means the row reached Postgres (uploads work) but
 * PowerSync's download stream is not connected, so sync is only half working and the gate is not met.
 */
export type CheckOutcome = ServerCheckResult | 'found-no-stream';

export type SyncCheckState = {
  /** The current step, or 'passed' once the row was found in Postgres. */
  step: StepId | 'passed';
  probe: Probe | null;
  busy: boolean;
  /** Result of the latest server check (shown until the next one). */
  result: CheckOutcome | null;
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
  | { type: 'check-finished'; result: ServerCheckResult; streamConnected: boolean }
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
    case 'check-finished': {
      // PASS needs both directions: the upload reached Postgres and the PowerSync stream (downloads)
      // is connected. Uploads go through the Supabase API and work even when PowerSync itself is
      // misconfigured, so a found row alone does not prove sync works.
      const result: CheckOutcome = action.result === 'found' && !action.streamConnected ? 'found-no-stream' : action.result;
      return {
        ...state,
        busy: false,
        result,
        step: result === 'found' ? 'passed' : state.step,
      };
    }
    case 'restart':
      return initialSyncCheckState;
  }
}

export function stepIndex(step: SyncCheckState['step']): number {
  return step === 'passed' ? STEPS.length : STEPS.findIndex((s) => s.id === step);
}

/** Message shown when the phone can still reach the server at the moment the row would be created. */
export const STILL_ONLINE_MESSAGE =
  'The phone can still reach the server, so this would not test offline saving. Turn on airplane mode and make sure Wi-Fi is off, then tap again.';

/** What the latest server check means, in plain words. */
export function describeCheckResult(result: CheckOutcome): { tone: 'success' | 'warning' | 'danger'; text: string } {
  switch (result) {
    case 'found':
      return { tone: 'success', text: 'PASS — the row made offline is in Postgres.' };
    case 'found-no-stream':
      return {
        tone: 'warning',
        text: 'The row reached Postgres, but the PowerSync stream is not connected, so downloads are not working yet. Check EXPO_PUBLIC_POWERSYNC_URL and PowerSync’s Supabase Auth setting, then check again.',
      };
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
