/**
 * Speaking notes instead of typing them: the rules, kept apart from the native module so they can be
 * tested. useDictation.ts drives Android's speech recognition (expo-speech-recognition 57.1.1) with
 * them; docs/research/voice/speech.md has the facts behind each one.
 *
 * - Which recognizer: on Android 13+ with an on-device service whose model for the language is
 *   installed, recognition runs on the phone ("works offline"); otherwise the phone's default speech
 *   service (usually Google's app), which sends the audio to Google; with neither, there is only
 *   typing (and the keyboard's own microphone).
 * - Android 13+ listens continuously (one session until it is stopped); older versions end each
 *   session after a pause, so the hook starts a new one while the person still wants it listening.
 * - Settings only Android 13+ knows are only ever sent there: the library sets each
 *   `androidIntentOptions` key by reflection, and a key the phone's Android doesn't have makes start()
 *   fail.
 * - No audio is kept: recordingOptions is never passed.
 */
import type { ExpoSpeechRecognitionErrorEvent, ExpoSpeechRecognitionOptions } from 'expo-speech-recognition';

import { NOTE_MAX_CHARS } from './studyApi';

export const DICTATION_LIMITS = {
  /** One set of notes (= the phone's note limit): dictation pauses there. */
  maxChars: NOTE_MAX_CHARS,
  /** Pause after this long with no new words (saves battery; Android warns about long sessions). */
  quietPauseMs: 60_000,
  /** How often the quiet timer looks. */
  quietCheckMs: 5_000,
  /** After stop(), how long to wait for the last words before giving up on them (abort()). */
  stopWatchdogMs: 4_000,
  /** Before starting the next session after one ended by itself (Android ≤ 12 ends at each pause). */
  restartDelayMs: 250,
  /** Before each retry after "busy" or "client" (the service was restarted too fast); then it pauses. */
  retryDelaysMs: [300, 600, 1200],
  /** getSupportedLocales can leave its promise unsettled when the service never answers. */
  localesTimeoutMs: 3_000,
  /** The character counter under the notes appears from here. */
  counterFromChars: 15_000,
} as const;

// ---- Which recognizer ---------------------------------------------------------------------------

export type Engine =
  /** The phone's on-device recognizer with the language installed: works offline. */
  | { kind: 'on-device' }
  /** The phone's default speech service (may send audio to Google). canDownload: an offline model exists. */
  | { kind: 'online'; canDownload: boolean }
  /** No online service, but the on-device one could have the language after a download. */
  | { kind: 'download-only' }
  /** No speech service at all: type, or use the keyboard's microphone. */
  | { kind: 'unavailable' };

export type EngineInputs = {
  /** Android API level (0 when not Android). */
  api: number;
  /** isRecognitionAvailable(): some app on the phone offers android.speech.RecognitionService. */
  recognitionAvailable: boolean;
  /** supportsOnDeviceRecognition(): the maker named an on-device service (not that a model is there). */
  onDeviceService: boolean;
  /** getSupportedLocales(): installed on the phone, and all it knows. */
  installed: readonly string[];
  supported: readonly string[];
  lang: string;
};

const norm = (tag: string) => tag.trim().replace(/_/g, '-').toLowerCase();

/** Whether `lang` is in a list of locales (any case; "en_US" and "en-US" are the same). */
export function localeMatches(list: readonly string[], lang: string): boolean {
  const wanted = norm(lang);
  return list.some((tag) => norm(tag) === wanted);
}

export function pickEngine(p: EngineInputs): Engine {
  const onDevice = p.api >= 33 && p.onDeviceService;
  if (onDevice && localeMatches(p.installed, p.lang)) return { kind: 'on-device' };
  const downloadable = onDevice && localeMatches(p.supported, p.lang);
  if (p.recognitionAvailable) return { kind: 'online', canDownload: downloadable };
  return downloadable ? { kind: 'download-only' } : { kind: 'unavailable' };
}

/** What start() is given. Only for an engine that can listen ('on-device' or 'online'). */
export function startOptions(engine: 'on-device' | 'online', lang: string, api: number): ExpoSpeechRecognitionOptions {
  return {
    // Always a real BCP 47 tag: '' would make the library send Java's "en_US" form.
    lang,
    interimResults: true,
    // Android 13+: one session until stopped. Older: plain sessions, restarted by the hook (the
    // library's long-silence extras there are documented as having no effect).
    continuous: api >= 33,
    // On 13+ this picks the on-device recognizer itself (never the network).
    requiresOnDeviceRecognition: engine === 'on-device',
    // Punctuation is only known to work with on-device recognition (the library's README).
    addsPunctuation: engine === 'on-device',
    maxAlternatives: 1,
    // Android 13+ keys only (EXTRA_MASK_OFFENSIVE_WORDS is API 33): notes are the person's own words.
    ...(api >= 33 ? { androidIntentOptions: { EXTRA_MASK_OFFENSIVE_WORDS: false } } : {}),
    volumeChangeEventOptions: { enabled: true, intervalMillis: 150 },
  };
}

// ---- Words --------------------------------------------------------------------------------------

/**
 * The notes after one more finished stretch of speech: joined with a space, or on a new paragraph
 * when the person picked up again after a pause. What is already there (their edits) is left alone.
 */
export function joinSegment(committed: string, segment: string, newParagraph = false): string {
  const words = segment.replace(/\s+/g, ' ').trim();
  if (!words) return committed;
  if (committed.trim() === '') return committed + words;
  if (newParagraph) {
    const base = committed.replace(/[ \t]+$/, '');
    const gap = base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n';
    return base + gap + words;
  }
  if (/\s$/.test(committed)) return committed + words;
  return `${committed} ${words}`;
}

/** A volume event's value (−2 … 10; below 0 is silence) as 0 … 1, for the mic's ring. */
export function levelFromVolume(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value / 10));
}

// ---- Errors -------------------------------------------------------------------------------------

/**
 * What to do about an `error` event (always followed by `end`):
 * - ignore: our own abort();
 * - restart: a pause in speech (no-speech, speech-timeout): start again if still listening;
 * - retry: the service was restarted too fast (busy, client): start again after a back-off;
 * - the rest pause dictation and say why.
 */
export type ErrorAction = 'ignore' | 'restart' | 'retry' | 'permission' | 'network' | 'language' | 'download' | 'busy-mic' | 'stop';

export function classifyError(e: Pick<ExpoSpeechRecognitionErrorEvent, 'error' | 'code'>): ErrorAction {
  // A string, not the library's union: 'too-many-requests' (code 10) is sent but missing from it.
  switch (e.error as string) {
    case 'aborted':
      return 'ignore';
    case 'no-speech':
    case 'speech-timeout':
      return 'restart';
    case 'busy':
    case 'client':
      return 'retry';
    case 'not-allowed':
    case 'service-not-allowed':
      return 'permission';
    case 'network':
      return 'network';
    case 'language-not-supported':
      // 13 = ERROR_LANGUAGE_UNAVAILABLE: supported, not downloaded yet. 12: not supported at all.
      return e.code === 13 ? 'download' : 'language';
    case 'audio-capture':
    case 'interrupted':
      return 'busy-mic';
    default:
      return 'stop'; // too-many-requests, unknown, bad-grammar, anything new
  }
}

/** Why dictation is paused (null: it never started, or the person paused it). */
export type PauseReason = 'quiet' | 'background' | 'cap' | 'service' | 'network' | 'language' | 'download' | 'permission' | 'busy-mic' | 'error';

/** The pause reason for an error that stops dictation. */
export function pauseReasonFor(action: ErrorAction): PauseReason | null {
  switch (action) {
    case 'ignore':
    case 'restart':
    case 'retry':
      return null;
    case 'permission':
    case 'network':
    case 'language':
    case 'download':
    case 'busy-mic':
      return action;
    case 'stop':
      return 'error';
  }
}

/** The status line's words for a pause (everything said so far is always kept). */
export function pauseMessage(reason: PauseReason | null, langName: string): string {
  switch (reason) {
    case null:
      return 'Paused. Tap the mic to carry on.';
    case 'quiet':
      return 'Paused after a minute of quiet. Tap the mic to carry on.';
    case 'background':
      return 'Paused while DualRep was in the background. Tap the mic to carry on.';
    case 'cap':
      return `That’s the most one set of notes can hold (${DICTATION_LIMITS.maxChars.toLocaleString('en-US')} characters). Add it to the plan, then start another.`;
    case 'service':
      return 'The speech service stopped. Tap the mic to try again.';
    case 'network':
      return 'Lost the connection to the speech service. Everything so far is kept. Tap the mic to try again.';
    case 'language':
      return `This phone can’t turn ${langName} speech into text. Choose another language, or type.`;
    case 'download':
      return `${langName} isn’t downloaded on this phone yet. Download it for offline use, or type.`;
    case 'permission':
      return 'DualRep can’t use the microphone. You can still type.';
    case 'busy-mic':
      return 'The microphone isn’t available right now. Another app may be using it. Tap the mic to try again.';
    case 'error':
      return 'Speech-to-text stopped. Everything so far is kept. Tap the mic to try again.';
  }
}

// ---- Languages ----------------------------------------------------------------------------------

/** English first, in this order, whatever the phone's language. */
export const ENGLISH_VARIANTS = ['en-US', 'en-GB', 'en-AU', 'en-CA', 'en-IN', 'en-IE', 'en-NZ', 'en-ZA'] as const;

const NAMES: Readonly<Record<string, string>> = {
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  'en-AU': 'English (Australia)',
  'en-CA': 'English (Canada)',
  'en-IN': 'English (India)',
  'en-IE': 'English (Ireland)',
  'en-NZ': 'English (New Zealand)',
  'en-ZA': 'English (South Africa)',
};

/**
 * A locale as speech recognition takes it: "en_us" → "en-US", "zh-hant-tw" → "zh-Hant-TW"; Unicode
 * extensions ("-u-ca-…") dropped. null when it is not a language tag.
 */
export function canonicalTag(tag: string | null | undefined): string | null {
  if (typeof tag !== 'string') return null;
  const parts = tag.trim().replace(/_/g, '-').split('-u-')[0].split('-').filter(Boolean);
  if (parts.length === 0 || !/^[A-Za-z]{2,3}$/.test(parts[0])) return null;
  const out = [parts[0].toLowerCase()];
  for (const part of parts.slice(1, 4)) {
    if (/^[A-Za-z]{4}$/.test(part)) out.push(part[0].toUpperCase() + part.slice(1).toLowerCase());
    else if (/^[A-Za-z]{2}$|^\d{3}$/.test(part)) out.push(part.toUpperCase());
    else if (/^[A-Za-z0-9]{5,8}$/.test(part)) out.push(part.toLowerCase());
    else return null;
  }
  return out.join('-');
}

/** The phone's language as a tag (Hermes' Intl gives "en-GB"), or null when it can't tell. */
export function phoneLocale(): string | null {
  try {
    return canonicalTag(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return null;
  }
}

/** The language to listen for: the one chosen on this phone, else the phone's own; "en" alone is US English. */
export function dictationLang(chosen: string | null, phone: string | null = phoneLocale()): string {
  const tag = canonicalTag(chosen) ?? canonicalTag(phone);
  if (!tag || tag === 'en') return 'en-US';
  return tag;
}

/** "English (UK)", "German (Germany)", or the tag itself when the phone has no name for it. */
export function languageName(tag: string): string {
  const known = NAMES[tag];
  if (known) return known;
  try {
    const DisplayNames = (Intl as unknown as { DisplayNames?: new (locales: string[], options: { type: 'language' }) => { of(code: string): string | undefined } })
      .DisplayNames;
    const name = DisplayNames ? new DisplayNames(['en'], { type: 'language' }).of(tag) : undefined;
    return name && name !== tag ? name : tag;
  } catch {
    return tag;
  }
}

/**
 * The languages offered: English variants first, then the phone's own language, then any others the
 * phone's speech service lists (Android 13+), in name order. No repeats; tags in canonical form.
 */
export function languageChoices(phone: string | null, supported: readonly string[]): string[] {
  const out: string[] = [...ENGLISH_VARIANTS];
  const add = (tag: string | null) => {
    if (tag && tag !== 'en' && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
  };
  add(canonicalTag(phone));
  const others = supported
    .map((tag) => canonicalTag(tag))
    .filter((tag): tag is string => tag !== null)
    .sort((a, b) => languageName(a).localeCompare(languageName(b), 'en'));
  for (const tag of others) add(tag);
  return out;
}
