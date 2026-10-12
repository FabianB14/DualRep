/**
 * Jest's stand-in for expo-speech-recognition, used by every test without a jest.mock call (a mock in
 * the __mocks__ folder next to node_modules replaces that package). The real module needs its native
 * side, which jest-expo does not provide: importing it bare throws "Cannot find native module
 * 'ExpoSpeechRecognition'", so any screen that imports the dictation hook would fail to load.
 *
 * It behaves like a phone where everything works: the microphone is allowed, a speech service is
 * there, and English (US) is installed for offline use. Nothing happens by itself: tests send the
 * native events with __emit, in the order Android sends them (docs/research/voice/speech.md 3.3), e.g.
 *
 *   import * as speechModule from 'expo-speech-recognition';
 *   const speech = speechModule as unknown as typeof speechModule & SpeechMockHelpers;
 *   act(() => { speech.__emit('result', { isFinal: true, results: [{ transcript: 'cells divide', confidence: 0.9, segments: [] }] }); });
 *
 * Import it as the app code does: jest.requireMock('expo-speech-recognition') returns a second copy
 * with its own listeners. __reset() puts the default answers back (call it in beforeEach when a test
 * changes them).
 */
import { jest } from '@jest/globals';

type Listener = (event: unknown) => void;
type Permission = { granted: boolean; status: 'granted' | 'denied' | 'undetermined'; canAskAgain: boolean; expires: 'never' };

const listeners = new Map<string, Set<Listener>>();

const GRANTED: Permission = { granted: true, status: 'granted', canAskAgain: true, expires: 'never' };

export const ExpoSpeechRecognitionModule = {
  start: jest.fn((_options: unknown) => undefined),
  stop: jest.fn(() => undefined),
  abort: jest.fn(() => undefined),
  getPermissionsAsync: jest.fn(async (): Promise<Permission> => GRANTED),
  requestPermissionsAsync: jest.fn(async (): Promise<Permission> => GRANTED),
  getMicrophonePermissionsAsync: jest.fn(async (): Promise<Permission> => GRANTED),
  requestMicrophonePermissionsAsync: jest.fn(async (): Promise<Permission> => GRANTED),
  isRecognitionAvailable: jest.fn(() => true),
  supportsOnDeviceRecognition: jest.fn(() => true),
  supportsRecording: jest.fn(() => true),
  getSupportedLocales: jest.fn(async (_options: unknown) => ({ locales: ['en-US', 'en-GB'], installedLocales: ['en-US'] })),
  androidTriggerOfflineModelDownload: jest.fn(async (_options: { locale: string }) => ({
    status: 'download_success' as 'download_success' | 'opened_dialog' | 'download_scheduled',
    message: '',
  })),
  getDefaultRecognitionService: jest.fn(() => ({ packageName: 'com.google.android.tts' })),
  getSpeechRecognitionServices: jest.fn(() => ['com.google.android.tts']),
  getStateAsync: jest.fn(async () => 'inactive'),
  addListener: jest.fn((name: string, listener: Listener) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(listener);
    return { remove: () => listeners.get(name)?.delete(listener) };
  }),
};

const DEFAULTS = Object.fromEntries(
  Object.entries(ExpoSpeechRecognitionModule).map(([name, fn]) => [name, fn.getMockImplementation()]),
) as Record<keyof typeof ExpoSpeechRecognitionModule, ((...args: never[]) => unknown) | undefined>;

/** The library's hook form of addListener (the app uses addListener directly). */
export function useSpeechRecognitionEvent(): void {}

/** Android's SpeechRecognizer error constants, as the library exports them. */
export const SpeechRecognizerErrorAndroid = {
  ERROR_NETWORK_TIMEOUT: 1,
  ERROR_NETWORK: 2,
  ERROR_AUDIO: 3,
  ERROR_SERVER: 4,
  ERROR_CLIENT: 5,
  ERROR_SPEECH_TIMEOUT: 6,
  ERROR_NO_MATCH: 7,
  ERROR_RECOGNIZER_BUSY: 8,
  ERROR_INSUFFICIENT_PERMISSIONS: 9,
  ERROR_TOO_MANY_REQUESTS: 10,
  ERROR_SERVER_DISCONNECTED: 11,
  ERROR_LANGUAGE_NOT_SUPPORTED: 12,
  ERROR_LANGUAGE_UNAVAILABLE: 13,
  ERROR_CANNOT_CHECK_SUPPORT: 14,
  ERROR_CANNOT_LISTEN_TO_DOWNLOAD_EVENTS: 15,
} as const;

/** Sends a native event to every listener of `name` (what the phone's speech service would do). */
export function __emit(name: string, payload: unknown = null): void {
  for (const listener of [...(listeners.get(name) ?? [])]) listener(payload);
}

/** How many listeners `name` has (a screen that left must have removed its own). */
export function __listenerCount(name: string): number {
  return listeners.get(name)?.size ?? 0;
}

/** Puts every default answer back and forgets the calls; listeners stay (mounted screens keep theirs). */
export function __reset(): void {
  for (const [name, fn] of Object.entries(ExpoSpeechRecognitionModule)) {
    fn.mockReset();
    const implementation = DEFAULTS[name as keyof typeof ExpoSpeechRecognitionModule];
    if (implementation) (fn as jest.Mock<(...args: never[]) => unknown>).mockImplementation(implementation);
  }
}

export type SpeechMockHelpers = {
  __emit: typeof __emit;
  __listenerCount: typeof __listenerCount;
  __reset: typeof __reset;
};
