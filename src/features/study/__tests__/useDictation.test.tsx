/**
 * The dictation loop against the expo-speech-recognition stand-in (__mocks__/expo-speech-recognition.ts):
 * native events are sent in the order Android sends them, timers are fake, and the tests check what
 * the hook asks of the recognizer and what the screen would show.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as speechModule from 'expo-speech-recognition';
import { AppState } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { DICTATION_LIMITS } from '../dictation';
import { cleanStudyText } from '../studyApi';
import { validateText } from '../upload';
import { useDictation, type Dictation } from '../useDictation';

type AnyMock = jest.Mock<(...args: any[]) => any>;
type SpeechMock = {
  ExpoSpeechRecognitionModule: { [K in keyof typeof speechModule.ExpoSpeechRecognitionModule]: AnyMock };
  __emit: (name: string, payload?: unknown) => void;
  __listenerCount: (name: string) => number;
  __reset: () => void;
};
// The module as the hook imports it: the stand-in from __mocks__ (jest.requireMock would give a
// second copy of it, with its own listeners).
const speech = speechModule as unknown as SpeechMock;
const native = speech.ExpoSpeechRecognitionModule;

jest.mock('expo-keep-awake', () => ({ activateKeepAwakeAsync: jest.fn(async () => undefined), deactivateKeepAwake: jest.fn(async () => undefined) }));
const keepAwake = jest.requireMock('expo-keep-awake') as { activateKeepAwakeAsync: AnyMock; deactivateKeepAwake: AnyMock };

const appStateListeners: ((state: string) => void)[] = [];

/** What the hook returned on each render (the last one is what the screen would show). */
const seen: Dictation[] = [];
const latest = (): Dictation => seen[seen.length - 1];
let renderer: ReactTestRenderer | null = null;

function Probe({ lang, api }: { lang: string; api: number }) {
  seen.push(useDictation({ lang, api }));
  return null;
}

/** Lets pending promises (the engine probe, the permission) settle. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let k = 0; k < 5; k += 1) await Promise.resolve();
  });
}

async function mount(api = 34, lang = 'en-US'): Promise<void> {
  await act(async () => {
    renderer = create(<Probe api={api} lang={lang} />);
  });
  await flush();
}

async function emit(name: string, payload: unknown = null): Promise<void> {
  await act(async () => {
    speech.__emit(name, payload);
  });
}

const result = (transcript: string, isFinal: boolean) => ({ isFinal, results: [{ transcript, confidence: 0.9, segments: [] }] });

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

async function tapMic(): Promise<void> {
  await act(async () => {
    await latest().toggle();
  });
}

beforeEach(() => {
  seen.length = 0;
  jest.useFakeTimers({ now: Date.UTC(2026, 9, 12, 9), doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  jest.clearAllMocks();
  speech.__reset();
  appStateListeners.length = 0;
  (AppState.addEventListener as unknown as AnyMock).mockImplementation((_type: string, listener: (state: string) => void) => {
    appStateListeners.push(listener);
    return { remove: () => undefined };
  });
});

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  jest.useRealTimers();
});

describe('which recognizer', () => {
  it('Android 13+ with English installed: on the phone, continuous, Android-13 keys only there', async () => {
    await mount(34);
    expect(latest().probe?.engine).toEqual({ kind: 'on-device' });
    expect(latest().probe?.installed).toEqual(['en-US']);
    await tapMic();
    expect(native.start).toHaveBeenCalledWith(
      expect.objectContaining({ lang: 'en-US', continuous: true, requiresOnDeviceRecognition: true, androidIntentOptions: { EXTRA_MASK_OFFENSIVE_WORDS: false } }),
    );
  });

  it('Android 12: the online service, plain sessions, no Android-13 keys', async () => {
    await mount(32);
    expect(latest().probe?.engine).toEqual({ kind: 'online', canDownload: false });
    expect(native.getSupportedLocales).not.toHaveBeenCalled();
    await tapMic();
    const options = native.start.mock.calls[0][0] as Record<string, unknown>;
    expect(options).toMatchObject({ continuous: false, requiresOnDeviceRecognition: false });
    expect(options).not.toHaveProperty('androidIntentOptions');
  });

  it('no speech service: unavailable, and the mic does nothing', async () => {
    native.isRecognitionAvailable.mockReturnValue(false);
    native.supportsOnDeviceRecognition.mockReturnValue(false);
    await mount(34);
    expect(latest().probe?.engine).toEqual({ kind: 'unavailable' });
    await tapMic();
    expect(native.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(native.start).not.toHaveBeenCalled();
  });

  it('a locale list that never comes back does not hold the screen up (online after 3 s)', async () => {
    native.getSupportedLocales.mockImplementation(() => new Promise(() => undefined));
    await mount(34, 'en-GB');
    expect(latest().probe).toBeNull();
    await advance(DICTATION_LIMITS.localesTimeoutMs);
    await flush();
    expect(latest().probe?.engine).toEqual({ kind: 'online', canDownload: false });
  });

  it('a language the phone could download: offers it, and looks again after the download', async () => {
    await mount(34, 'en-GB');
    expect(latest().probe?.engine).toEqual({ kind: 'online', canDownload: true });
    native.getSupportedLocales.mockResolvedValue({ locales: ['en-US', 'en-GB'], installedLocales: ['en-US', 'en-GB'] });
    let outcome = '';
    await act(async () => {
      outcome = await latest().downloadOffline();
    });
    await flush();
    expect(outcome).toBe('done');
    expect(native.androidTriggerOfflineModelDownload).toHaveBeenCalledWith({ locale: 'en-GB' });
    expect(latest().probe?.engine).toEqual({ kind: 'on-device' });
  });
});

describe('listening', () => {
  it('in-progress words are live; finished ones join the notes; pausing waits for the last words', async () => {
    await mount(34);
    await tapMic();
    expect(latest().status).toBe('starting');
    expect(keepAwake.activateKeepAwakeAsync).toHaveBeenCalledWith('dualrep-dictation');
    await emit('start');
    expect(latest().status).toBe('listening');
    await emit('result', result('cells', false));
    await emit('result', result('cells divide', false));
    expect([latest().live, latest().text]).toEqual(['cells divide', '']);
    await emit('result', result('cells divide by mitosis', true));
    expect([latest().live, latest().text]).toEqual(['', 'cells divide by mitosis']);
    await emit('result', result('in the nucleus', false));
    await act(async () => latest().pause());
    expect(native.stop).toHaveBeenCalledTimes(1);
    expect(latest().status).toBe('stopping');
    expect(keepAwake.deactivateKeepAwake).toHaveBeenCalledWith('dualrep-dictation');
    // The recognizer ends without making the last words final: they are kept anyway.
    await emit('end');
    expect([latest().status, latest().live, latest().text, latest().pauseReason]).toEqual(['off', '', 'cells divide by mitosis in the nucleus', null]);
    await advance(5_000);
    expect(native.start).toHaveBeenCalledTimes(1);
  });

  it('a service that never says it is ready still shows listening once words come', async () => {
    await mount(34);
    await tapMic();
    await emit('result', result('cells', false));
    expect([latest().status, latest().live]).toEqual(['listening', 'cells']);
    // Words still in a pause's last answer do not undo the pause.
    await act(async () => latest().pause());
    await emit('result', result('cells divide', true));
    expect(latest().status).toBe('stopping');
    await emit('end');
    expect([latest().status, latest().text]).toEqual(['off', 'cells divide']);
  });

  it('Android ≤ 12: a session that ends at a pause starts again while the person still wants it', async () => {
    await mount(30);
    await tapMic();
    await emit('start');
    await emit('result', result('osmosis moves water', true));
    await emit('error', { error: 'no-speech', message: '', code: 7 });
    await emit('end');
    expect(latest().status).toBe('listening');
    await advance(DICTATION_LIMITS.restartDelayMs - 1);
    expect(native.start).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(native.start).toHaveBeenCalledTimes(2);
    await emit('start');
    await emit('result', result('across a membrane', true));
    expect(latest().text).toBe('osmosis moves water across a membrane');
  });

  it('busy service: three retries with growing waits, then it pauses and says so', async () => {
    await mount(34);
    await tapMic();
    for (const wait of DICTATION_LIMITS.retryDelaysMs) {
      const before = native.start.mock.calls.length;
      await emit('error', { error: 'busy', message: '', code: 8 });
      await emit('end');
      await advance(wait - 1);
      expect(native.start.mock.calls.length).toBe(before);
      await advance(1);
      expect(native.start.mock.calls.length).toBe(before + 1);
    }
    await emit('error', { error: 'client', message: '', code: 5 });
    await emit('end');
    expect([latest().status, latest().pauseReason]).toEqual(['off', 'service']);
    await advance(10_000);
    expect(native.start).toHaveBeenCalledTimes(4);
  });

  it('new words reset the retry count', async () => {
    await mount(34);
    await tapMic();
    for (let round = 0; round < 3; round += 1) {
      await emit('error', { error: 'busy', message: '', code: 8 });
      await emit('end');
      await advance(2_000);
      await emit('result', result(`word ${round}`, true));
    }
    expect(latest().status).not.toBe('off');
  });

  it('errors it can’t get past pause with a reason, keeping the notes', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ error: 'network', code: 2 }, 'network'],
      [{ error: 'language-not-supported', code: 12 }, 'language'],
      [{ error: 'language-not-supported', code: 13 }, 'download'],
      [{ error: 'audio-capture', code: 3 }, 'busy-mic'],
      [{ error: 'too-many-requests', code: 10 }, 'error'],
      [{ error: 'service-not-allowed', code: 9 }, 'service-permission'],
      [{ error: 'not-allowed', code: -1 }, 'permission'],
    ];
    await mount(34);
    for (const [error, reason] of cases) {
      await tapMic();
      await emit('result', result('kept', true));
      await emit('error', { message: '', ...error });
      await emit('end');
      expect([error.error, latest().status, latest().pauseReason]).toEqual([error.error, 'off', reason]);
    }
    expect(latest().text).toBe('kept\n\nkept\n\nkept\n\nkept\n\nkept\n\nkept\n\nkept');
  });

  it('the speech service’s own missing microphone (code 9) is not taken for DualRep’s', async () => {
    await mount(32);
    await tapMic();
    await emit('error', { error: 'service-not-allowed', message: 'Insufficient permissions', code: 9 });
    await emit('end');
    await flush();
    // DualRep may use the microphone: the screen must not ask the person to allow it again.
    expect([latest().status, latest().pauseReason, latest().permission]).toEqual(['off', 'service-permission', 'granted']);
    expect(latest().probe?.service).toBe('com.google.android.tts');
    // Once the service is allowed it in settings, the next tap just starts.
    await tapMic();
    expect(native.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(native.start).toHaveBeenCalledTimes(2);
    expect(latest().pauseReason).toBeNull();
  });

  it('pauses after a minute without new words', async () => {
    await mount(34);
    await tapMic();
    await emit('start');
    await advance(30_000);
    await emit('result', result('one', false));
    await advance(DICTATION_LIMITS.quietPauseMs - 1_000);
    expect(native.stop).not.toHaveBeenCalled();
    await advance(DICTATION_LIMITS.quietPauseMs);
    expect(native.stop).toHaveBeenCalledTimes(1);
    expect(latest().pauseReason).toBe('quiet');
    await emit('end');
    expect([latest().status, latest().text]).toEqual(['off', 'one']);
  });

  it('a recognizer that never answers stop() is given up on after 4 s', async () => {
    await mount(34);
    await tapMic();
    await emit('result', result('half a thought', false));
    let final: string | null = null;
    await act(async () => {
      void latest().finish().then((text) => {
        final = text;
      });
    });
    expect(latest().status).toBe('stopping');
    await advance(DICTATION_LIMITS.stopWatchdogMs - 1);
    expect(native.abort).not.toHaveBeenCalled();
    await advance(1);
    expect(native.abort).toHaveBeenCalledTimes(1);
    expect(latest().status).toBe('off');
    expect(final).toBe('half a thought');
  });

  it('finish() while listening resolves with the last words once the recognizer is done', async () => {
    await mount(34);
    await tapMic();
    await emit('result', result('the krebs', false));
    let final: string | null = null;
    await act(async () => {
      void latest().finish().then((text) => {
        final = text;
      });
    });
    expect(final).toBeNull();
    await emit('result', result('the krebs cycle', true));
    await emit('end');
    expect(final).toBe('the krebs cycle');
    // Not listening: at once.
    await act(async () => {
      final = await latest().finish();
    });
    expect(final).toBe('the krebs cycle');
  });

  it('leaving the app pauses; coming back looks at the recognizer again', async () => {
    await mount(34);
    await tapMic();
    await emit('start');
    await act(async () => appStateListeners.forEach((listener) => listener('background')));
    expect(native.stop).toHaveBeenCalledTimes(1);
    expect(latest().pauseReason).toBe('background');
    await emit('end');
    const probes = native.isRecognitionAvailable.mock.calls.length;
    await act(async () => appStateListeners.forEach((listener) => listener('active')));
    await flush();
    expect(native.isRecognitionAvailable.mock.calls.length).toBe(probes + 1);
    expect(latest().status).toBe('off');
  });

  it('stops at the note limit, and won’t start again while the notes are full', async () => {
    await mount(34);
    const typed = 'x'.repeat(DICTATION_LIMITS.maxChars - 10);
    await act(async () => latest().setText(typed));
    await tapMic();
    await emit('result', result('one more sentence to finish', true));
    expect(native.stop).toHaveBeenCalledTimes(1);
    expect(latest().pauseReason).toBe('cap');
    // Android 13+ sends what it was still working on after stop().
    await emit('result', result('and the last words', true));
    await emit('end');
    // The notes can be added as they are ("Add it to the plan", as the screen says)…
    expect(() => validateText(latest().text)).not.toThrow();
    expect(cleanStudyText(latest().text).length).toBeLessThanOrEqual(DICTATION_LIMITS.maxChars);
    // …and every word is kept, in order: what didn't fit waits for the next set.
    expect(latest().text).toBe(`${typed}\n\none more`);
    expect(latest().overflow).toBe('sentence to finish and the last words');
    native.start.mockClear();
    await tapMic();
    expect(native.start).not.toHaveBeenCalled();
    expect(latest().pauseReason).toBe('cap');
    expect(latest().overflow).toBe('sentence to finish and the last words');
    let next = '';
    await act(async () => {
      next = latest().takeOverflow();
    });
    expect([next, latest().overflow]).toEqual(['sentence to finish and the last words', '']);
  });

  it('words still being heard when it pauses at the limit wait for the next set too', async () => {
    await mount(34);
    const typed = 'x'.repeat(DICTATION_LIMITS.maxChars - 4);
    await act(async () => latest().setText(typed));
    await tapMic();
    // Exactly full: it pauses, and nothing more fits.
    await emit('result', result('ab', true));
    await emit('result', result('half a sentence', false));
    expect(latest().pauseReason).toBe('cap');
    // The recognizer never answers stop(): the words still being heard are kept anyway.
    await advance(DICTATION_LIMITS.stopWatchdogMs);
    expect(latest().status).toBe('off');
    expect([latest().text, latest().overflow, latest().pauseReason]).toEqual([`${typed}\n\nab`, 'half a sentence', 'cap']);
    expect(() => validateText(latest().text)).not.toThrow();
  });

  it('last words that fill the notes after the person paused say so too', async () => {
    await mount(34);
    const typed = 'x'.repeat(DICTATION_LIMITS.maxChars - 12);
    await act(async () => latest().setText(typed));
    await tapMic();
    await act(async () => latest().pause());
    expect(latest().pauseReason).toBeNull();
    await emit('result', result('cells divide by mitosis', true));
    await emit('end');
    expect([latest().text, latest().overflow, latest().pauseReason]).toEqual([`${typed}\n\ncells`, 'divide by mitosis', 'cap']);
  });

  it('shortened notes take the words that didn’t fit back first, then carry on', async () => {
    await mount(34);
    await act(async () => latest().setText('x'.repeat(DICTATION_LIMITS.maxChars - 10)));
    await tapMic();
    await emit('result', result('one more sentence to finish', true));
    await emit('end');
    expect(latest().overflow).toBe('sentence to finish');
    await act(async () => latest().setText('Short notes.\n\none more'));
    await tapMic();
    expect(native.start).toHaveBeenCalledTimes(2);
    expect([latest().text, latest().overflow]).toEqual(['Short notes.\n\none more sentence to finish', '']);
    await emit('result', result('then something new', true));
    expect(latest().text).toBe('Short notes.\n\none more sentence to finish\n\nthen something new');
  });

  it('words that didn’t fit come back with a saved draft', async () => {
    await mount(34);
    await act(async () => {
      latest().setText('x'.repeat(DICTATION_LIMITS.maxChars));
      latest().setOverflow('from before');
    });
    expect(latest().overflow).toBe('from before');
    await tapMic();
    expect(native.start).not.toHaveBeenCalled();
    expect([latest().pauseReason, latest().overflow]).toEqual(['cap', 'from before']);
  });

  it('picking up after a pause starts a new paragraph', async () => {
    await mount(34);
    await act(async () => latest().setText('Typed first.'));
    await tapMic();
    await emit('result', result('then spoken', true));
    expect(latest().text).toBe('Typed first.\n\nthen spoken');
  });

  it('leaving the screen stops the recognizer and its listeners', async () => {
    await mount(34);
    await tapMic();
    expect(speech.__listenerCount('result')).toBe(1);
    act(() => renderer!.unmount());
    renderer = null;
    expect(native.abort).toHaveBeenCalledTimes(1);
    expect(speech.__listenerCount('result')).toBe(0);
    expect(speech.__listenerCount('end')).toBe(0);
  });
});

describe('the microphone permission', () => {
  it('is asked for on the first tap, never before', async () => {
    native.getPermissionsAsync.mockResolvedValue({ granted: false, status: 'undetermined', canAskAgain: true, expires: 'never' });
    await mount(34);
    expect(native.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(latest().permission).toBe('unknown');
    await tapMic();
    expect(native.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(latest().permission).toBe('granted');
    expect(native.start).toHaveBeenCalledTimes(1);
  });

  it('refused: nothing starts and the next tap asks again', async () => {
    native.getPermissionsAsync.mockResolvedValue({ granted: false, status: 'undetermined', canAskAgain: true, expires: 'never' });
    native.requestPermissionsAsync.mockResolvedValue({ granted: false, status: 'denied', canAskAgain: true, expires: 'never' });
    await mount(34);
    await tapMic();
    expect([latest().permission, latest().pauseReason, latest().status]).toEqual(['denied', 'permission', 'off']);
    expect(native.start).not.toHaveBeenCalled();
    await tapMic();
    expect(native.requestPermissionsAsync).toHaveBeenCalledTimes(2);
  });

  it('refused for good: says so without asking (only system settings can allow it)', async () => {
    native.getPermissionsAsync.mockResolvedValue({ granted: false, status: 'denied', canAskAgain: false, expires: 'never' });
    await mount(34);
    expect(latest().permission).toBe('blocked');
    await tapMic();
    expect(native.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(native.start).not.toHaveBeenCalled();
    expect(latest().permission).toBe('blocked');
  });
});
