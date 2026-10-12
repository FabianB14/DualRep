/**
 * Speech-to-text for the notes screen: Android's own speech recognition through
 * expo-speech-recognition, wrapped so the screen only sees the notes, the words still being heard,
 * and a plain state. The rules live in dictation.ts; this hook is the loop around the native module.
 *
 * - Listening is the person's choice (`want`), separate from the recognizer's sessions: on Android
 *   ≤ 12 each session ends after a pause, so while they still want it listening the next one starts
 *   by itself (after a short delay, or a back-off when the service says it is busy). Android 13+ keeps
 *   one session open, and the same loop is the safety net when a service ends it anyway.
 * - It pauses by itself after a minute without new words, when the app leaves the foreground (Android
 *   gives a background app silence anyway), at the note limit, and on an error it can't get past;
 *   `pauseReason` says which. Words are never dropped: a final result is added to the notes as soon
 *   as it comes, and words still in progress when a session ends are added too.
 * - The notes never grow past the note limit, so "Add to plan" always takes them: words that don't fit
 *   (the rest of the sentence that reached the limit, and the last words after the pause) wait in
 *   `overflow`, in order, and start the next set of notes. If the person shortens the notes, the next
 *   tap on the mic puts them back first, as far as they fit.
 * - Pausing calls stop(), which lets the recognizer send its last words; if it hasn't ended within 4
 *   seconds, abort() gives up on them. finish() pauses and resolves with the notes once that is done
 *   ("Add to plan" while listening).
 * - The screen stays on only while listening (expo-keep-awake). No audio is kept.
 * - The microphone permission is asked for on the first tap, never before.
 */
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { ExpoSpeechRecognitionModule as Speech, type ExpoSpeechRecognitionErrorEvent, type ExpoSpeechRecognitionResultEvent } from 'expo-speech-recognition';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, AppState, Platform } from 'react-native';

import {
  classifyError,
  DICTATION_LIMITS,
  fitSegment,
  joinSegment,
  levelFromVolume,
  pauseReasonFor,
  pickEngine,
  startOptions,
  type Engine,
  type ErrorAction,
  type PauseReason,
} from './dictation';
import { cleanStudyText } from './studyApi';

const KEEP_AWAKE_TAG = 'dualrep-dictation';

/** off: not listening (the notes can be edited). stopping: paused, waiting for the last words. */
export type DictationStatus = 'off' | 'starting' | 'listening' | 'stopping';

/** unknown: not asked yet (or asked once and refused: the next tap asks again). blocked: only system settings can allow it. */
export type MicPermission = 'unknown' | 'granted' | 'denied' | 'blocked';

/** service: the default speech service's package ('' when unknown), which the online engine uses. */
export type EngineProbe = { engine: Engine; installed: string[]; supported: string[]; service: string };

/** The Android API level, or 0 elsewhere. Read when called, so tests can change Platform. */
export function androidApi(): number {
  return Platform.OS === 'android' ? Number(Platform.Version) || 0 : 0;
}

function safely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** Resolves with the promise's value, or null when it fails or takes longer than `ms`. */
async function within<T>(promise: () => Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(promise), late]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Which recognizer can listen for `lang` on this phone right now (dictation.ts pickEngine). */
export async function probeEngine(lang: string, api: number): Promise<EngineProbe> {
  const recognitionAvailable = safely(() => Speech.isRecognitionAvailable(), false);
  const onDeviceService = api >= 33 && safely(() => Speech.supportsOnDeviceRecognition(), false);
  let installed: string[] = [];
  let supported: string[] = [];
  if (onDeviceService) {
    const locales = await within(() => Speech.getSupportedLocales({}), DICTATION_LIMITS.localesTimeoutMs);
    installed = Array.isArray(locales?.installedLocales) ? locales.installedLocales : [];
    supported = Array.isArray(locales?.locales) ? locales.locales : [];
  }
  const service = safely(() => Speech.getDefaultRecognitionService()?.packageName ?? '', '');
  return { engine: pickEngine({ api, recognitionAvailable, onDeviceService, installed, supported, lang }), installed, supported, service };
}

/** The microphone permission, asking for it when it may still be asked for. */
export async function askForMicrophone(): Promise<MicPermission> {
  const current = await Speech.getPermissionsAsync().catch(() => null);
  if (current?.granted) return 'granted';
  if (current && current.status === 'denied' && !current.canAskAgain) return 'blocked';
  const answer = await Speech.requestPermissionsAsync().catch(() => null);
  if (answer?.granted) return 'granted';
  return answer && !answer.canAskAgain ? 'blocked' : 'denied';
}

/** The permission as it is now, without asking. */
async function readMicrophone(): Promise<MicPermission> {
  const current = await Speech.getPermissionsAsync().catch(() => null);
  if (current?.granted) return 'granted';
  if (current && current.status === 'denied' && !current.canAskAgain) return 'blocked';
  return 'unknown';
}

export type Dictation = {
  /** The notes: everything heard so far plus the person's edits. */
  text: string;
  /** Typing and edits (the screen only allows them while `status` is 'off'). */
  setText(text: string): void;
  /** Words still being heard (they may change); shown greyed, not part of `text` yet. */
  live: string;
  /** Words heard after the notes were full: not part of `text`; they start the next set of notes. */
  overflow: string;
  /** Puts back words that didn't fit (a saved draft), or empties them ('' when the notes are cleared). */
  setOverflow(text: string): void;
  /** The words that didn't fit, emptying them here (the notes were added; they start the next set). */
  takeOverflow(): string;
  status: DictationStatus;
  /** Why it paused by itself, or null (never started, or paused by the person). */
  pauseReason: PauseReason | null;
  /** null while it is still finding out which recognizer this phone has. */
  probe: EngineProbe | null;
  permission: MicPermission;
  /** The voice level, 0 … 1, for the mic's ring (an Animated.Value: changing it never re-renders). */
  level: Animated.Value;
  /** The mic button: starts listening (asking for the microphone the first time), or pauses. */
  toggle(): Promise<void>;
  pause(): void;
  /** Pauses and resolves with the notes once the last words are in. */
  finish(): Promise<string>;
  /** Asks the phone to download `lang` for offline use, then looks again. */
  downloadOffline(): Promise<'done' | 'scheduled' | 'dialog' | 'failed'>;
};

export function useDictation({ lang, api = androidApi() }: { lang: string; api?: number }): Dictation {
  const [text, setTextState] = useState('');
  const [live, setLiveState] = useState('');
  const [overflow, setOverflowState] = useState('');
  const [status, setStatus] = useState<DictationStatus>('off');
  const [pauseReason, setPauseReason] = useState<PauseReason | null>(null);
  const [probe, setProbe] = useState<EngineProbe | null>(null);
  const [permission, setPermission] = useState<MicPermission>('unknown');
  const [checks, setChecks] = useState(0);
  const [level] = useState(() => new Animated.Value(0));

  // The native listeners are set up once, so everything they read is in refs.
  const textRef = useRef('');
  const liveRef = useRef('');
  const overflowRef = useRef('');
  const want = useRef(false);
  const session = useRef(false);
  const asking = useRef(false);
  const mounted = useRef(true);
  const heardAt = useRef(0);
  const retries = useRef(0);
  const lastError = useRef<ErrorAction | null>(null);
  const newParagraph = useRef(false);
  const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quietTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const waiters = useRef<((text: string) => void)[]>([]);
  const engineRef = useRef<Engine | null>(null);
  const langRef = useRef(lang);
  const apiRef = useRef(api);
  useEffect(() => {
    langRef.current = lang;
    apiRef.current = api;
    engineRef.current = probe?.engine ?? null;
  }, [lang, api, probe]);

  const setText = useCallback((next: string) => {
    textRef.current = next;
    setTextState(next);
  }, []);

  const setLive = useCallback((next: string) => {
    liveRef.current = next;
    setLiveState(next);
  }, []);

  const setOverflow = useCallback((next: string) => {
    overflowRef.current = next;
    setOverflowState(next);
  }, []);

  const takeOverflow = useCallback(() => {
    const words = overflowRef.current;
    setOverflow('');
    return words;
  }, [setOverflow]);

  /**
   * Adds finished words to the notes, as many as fit (fitSegment); the rest wait in `overflow`, and
   * once anything waits there, so does everything after it (the words stay in order). True when the
   * notes are full.
   */
  const keep = useCallback(
    (segment: string): boolean => {
      if (overflowRef.current) {
        setOverflow(joinSegment(overflowRef.current, segment));
      } else {
        const kept = fitSegment(textRef.current, segment, newParagraph.current);
        if (kept.text !== textRef.current) {
          newParagraph.current = false;
          setText(kept.text);
        }
        if (kept.overflow) setOverflow(kept.overflow);
      }
      return overflowRef.current !== '' || cleanStudyText(textRef.current).length >= DICTATION_LIMITS.maxChars;
    },
    [setOverflow, setText],
  );

  const clearTimers = useCallback(() => {
    if (restartTimer.current) clearTimeout(restartTimer.current);
    if (quietTimer.current) clearInterval(quietTimer.current);
    restartTimer.current = null;
    quietTimer.current = null;
  }, []);

  /** Not listening any more and no session open: the notes are final. */
  const settle = useCallback(() => {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    session.current = false;
    if (liveRef.current) {
      const words = liveRef.current;
      setLive('');
      if (keep(words) && mounted.current) setPauseReason('cap');
    }
    level.setValue(0);
    if (mounted.current) setStatus('off');
    for (const resolve of waiters.current.splice(0)) resolve(textRef.current);
  }, [keep, level, setLive]);

  /** Stops listening (by the person when `reason` is null, else by itself), keeping every word. */
  const stopListening = useCallback(
    (reason: PauseReason | null) => {
      want.current = false;
      clearTimers();
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
      if (mounted.current) setPauseReason(reason);
      if (!session.current) {
        settle();
        return;
      }
      // Let the recognizer send its last words; give up on them if it never ends.
      safely(() => Speech.stop(), undefined);
      if (mounted.current) setStatus('stopping');
      if (stopTimer.current) clearTimeout(stopTimer.current);
      stopTimer.current = setTimeout(() => {
        safely(() => Speech.abort(), undefined);
        settle();
      }, DICTATION_LIMITS.stopWatchdogMs);
    },
    [clearTimers, settle],
  );

  const commit = useCallback(
    (segment: string) => {
      if (!keep(segment)) return;
      // The notes are full: they can be added as they are, and nothing more fits.
      if (want.current) stopListening('cap');
      else if (mounted.current) setPauseReason('cap');
    },
    [keep, stopListening],
  );

  /** Opens a recognition session (the person still wants it listening). */
  const begin = useCallback(() => {
    restartTimer.current = null;
    const engine = engineRef.current;
    if (!want.current) return;
    if (!engine || (engine.kind !== 'on-device' && engine.kind !== 'online')) {
      stopListening('error');
      return;
    }
    session.current = true;
    try {
      Speech.start(startOptions(engine.kind, langRef.current, apiRef.current));
    } catch {
      session.current = false;
      stopListening('error');
    }
  }, [stopListening]);

  const later = useCallback(
    (ms: number) => {
      restartTimer.current = setTimeout(begin, ms);
    },
    [begin],
  );

  // The native events, for as long as the screen is open.
  useEffect(() => {
    mounted.current = true;
    const pending = waiters.current;
    const subscriptions = [
      Speech.addListener('start', () => {
        if (want.current) setStatus('listening');
      }),
      Speech.addListener('result', (event: ExpoSpeechRecognitionResultEvent) => {
        heardAt.current = Date.now();
        retries.current = 0;
        // Words are coming, so it is listening even if this service never said it was ready.
        if (want.current) setStatus('listening');
        const words = event.results[0]?.transcript ?? '';
        if (event.isFinal) {
          setLive('');
          commit(words);
        } else {
          setLive(words);
        }
      }),
      Speech.addListener('volumechange', (event: { value: number }) => level.setValue(levelFromVolume(event.value))),
      Speech.addListener('error', (event: ExpoSpeechRecognitionErrorEvent) => {
        lastError.current = classifyError(event);
      }),
      Speech.addListener('end', () => {
        session.current = false;
        level.setValue(0);
        // Words still in progress when a session ends are kept.
        if (liveRef.current) {
          const words = liveRef.current;
          setLive('');
          commit(words);
        }
        const action = lastError.current;
        lastError.current = null;
        if (!want.current) {
          settle();
          return;
        }
        if (action === null || action === 'restart' || action === 'ignore') {
          later(DICTATION_LIMITS.restartDelayMs);
          return;
        }
        if (action === 'retry') {
          const delay = DICTATION_LIMITS.retryDelaysMs[retries.current];
          retries.current += 1;
          if (delay === undefined) stopListening('service');
          else later(delay);
          return;
        }
        stopListening(pauseReasonFor(action) ?? 'error');
        if (action === 'permission') readMicrophone().then((p) => mounted.current && setPermission(p === 'unknown' ? 'denied' : p));
        if (action === 'download' || action === 'language') setChecks((n) => n + 1);
      }),
    ];
    return () => {
      mounted.current = false;
      for (const subscription of subscriptions) subscription.remove();
      want.current = false;
      clearTimers();
      if (stopTimer.current) clearTimeout(stopTimer.current);
      if (session.current) safely(() => Speech.abort(), undefined);
      session.current = false;
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
      for (const resolve of pending.splice(0)) resolve(textRef.current);
    };
  }, [clearTimers, commit, later, level, setLive, settle, stopListening]);

  // Leaving the app pauses (a background app can't use the microphone); coming back looks again at
  // the recognizer and the permission (a language downloaded, the microphone allowed in settings).
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setChecks((n) => n + 1);
      } else if (state === 'background' && want.current) {
        stopListening('background');
      }
    });
    return () => subscription.remove();
  }, [stopListening]);

  // Which recognizer can listen for this language (again when the language changes or the app returns).
  useEffect(() => {
    let current = true;
    probeEngine(lang, api)
      .then((result) => {
        if (current) setProbe(result);
      })
      .catch(() => undefined);
    readMicrophone()
      .then((p) => {
        if (current) setPermission((before) => (p === 'unknown' && before === 'denied' ? before : p));
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [lang, api, checks]);

  const pause = useCallback(() => {
    if (want.current) stopListening(null);
  }, [stopListening]);

  const toggle = useCallback(async () => {
    if (want.current) {
      stopListening(null);
      return;
    }
    const engine = engineRef.current;
    if (asking.current || session.current || !engine || (engine.kind !== 'on-device' && engine.kind !== 'online')) return;
    // Words that didn't fit go back in first, as far as there is room now (the notes were shortened).
    if (overflowRef.current) {
      const waiting = overflowRef.current;
      setOverflow('');
      keep(waiting);
    }
    if (overflowRef.current || cleanStudyText(textRef.current).length >= DICTATION_LIMITS.maxChars) {
      setPauseReason('cap');
      return;
    }
    asking.current = true;
    let allowed: MicPermission;
    try {
      allowed = await askForMicrophone();
    } finally {
      asking.current = false;
    }
    if (!mounted.current) return;
    setPermission(allowed);
    if (allowed !== 'granted') {
      setPauseReason('permission');
      return;
    }
    want.current = true;
    retries.current = 0;
    lastError.current = null;
    heardAt.current = Date.now();
    // Picking up again after a pause starts a new paragraph.
    newParagraph.current = textRef.current.trim() !== '';
    setPauseReason(null);
    setStatus('starting');
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
    quietTimer.current = setInterval(() => {
      if (want.current && Date.now() - heardAt.current >= DICTATION_LIMITS.quietPauseMs) stopListening('quiet');
    }, DICTATION_LIMITS.quietCheckMs);
    begin();
  }, [begin, keep, setOverflow, stopListening]);

  const finish = useCallback((): Promise<string> => {
    if (want.current) stopListening(null);
    if (!session.current) return Promise.resolve(textRef.current);
    return new Promise<string>((resolve) => waiters.current.push(resolve));
  }, [stopListening]);

  const downloadOffline = useCallback(async (): Promise<'done' | 'scheduled' | 'dialog' | 'failed'> => {
    try {
      const result = await Speech.androidTriggerOfflineModelDownload({ locale: langRef.current });
      return result.status === 'download_success' ? 'done' : result.status === 'download_scheduled' ? 'scheduled' : 'dialog';
    } catch {
      return 'failed';
    } finally {
      if (mounted.current) setChecks((n) => n + 1);
    }
  }, []);

  return { text, setText, live, overflow, setOverflow, takeOverflow, status, pauseReason, probe, permission, level, toggle, pause, finish, downloadOffline };
}
