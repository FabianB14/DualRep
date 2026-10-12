import { describe, expect, it } from '@jest/globals';

import {
  canonicalTag,
  classifyError,
  DICTATION_LIMITS,
  dictationLang,
  joinSegment,
  languageChoices,
  languageName,
  levelFromVolume,
  localeMatches,
  pauseMessage,
  pauseReasonFor,
  pickEngine,
  startOptions,
  type EngineInputs,
  type PauseReason,
} from '../dictation';

const base: EngineInputs = { api: 34, recognitionAvailable: true, onDeviceService: true, installed: ['en-US'], supported: ['en-US', 'en-GB'], lang: 'en-US' };

describe('pickEngine', () => {
  it('on the phone when Android 13+ has the language installed (any spelling of the tag)', () => {
    expect(pickEngine(base)).toEqual({ kind: 'on-device' });
    expect(pickEngine({ ...base, installed: ['EN_us'] })).toEqual({ kind: 'on-device' });
    expect(pickEngine({ ...base, api: 33 })).toEqual({ kind: 'on-device' });
  });

  it('online otherwise, saying when an offline download exists for the language', () => {
    expect(pickEngine({ ...base, lang: 'en-GB' })).toEqual({ kind: 'online', canDownload: true });
    expect(pickEngine({ ...base, lang: 'de-DE' })).toEqual({ kind: 'online', canDownload: false });
    // Android 12 and older: never on-device (the setting there is only a hint the service may ignore).
    expect(pickEngine({ ...base, api: 32 })).toEqual({ kind: 'online', canDownload: false });
    // The maker names no on-device service: the lists don't matter.
    expect(pickEngine({ ...base, onDeviceService: false })).toEqual({ kind: 'online', canDownload: false });
  });

  it('download-only or unavailable when there is no online service', () => {
    expect(pickEngine({ ...base, recognitionAvailable: false, lang: 'en-GB' })).toEqual({ kind: 'download-only' });
    expect(pickEngine({ ...base, recognitionAvailable: false, lang: 'en-GB', api: 32 })).toEqual({ kind: 'unavailable' });
    expect(pickEngine({ ...base, recognitionAvailable: false, onDeviceService: false })).toEqual({ kind: 'unavailable' });
  });

  it('localeMatches ignores case and _ versus -', () => {
    expect(localeMatches(['en_GB', 'fr-FR'], 'en-gb')).toBe(true);
    expect(localeMatches(['en-GB'], 'en-US')).toBe(false);
    expect(localeMatches([], 'en-US')).toBe(false);
  });
});

describe('startOptions', () => {
  it('Android 13+: continuous, with the Android-13-only setting', () => {
    expect(startOptions('on-device', 'en-GB', 33)).toEqual({
      lang: 'en-GB',
      interimResults: true,
      continuous: true,
      requiresOnDeviceRecognition: true,
      addsPunctuation: true,
      maxAlternatives: 1,
      androidIntentOptions: { EXTRA_MASK_OFFENSIVE_WORDS: false },
      volumeChangeEventOptions: { enabled: true, intervalMillis: 150 },
    });
    expect(startOptions('online', 'en-US', 35)).toMatchObject({ continuous: true, requiresOnDeviceRecognition: false, addsPunctuation: false });
  });

  it('Android 12 and older: plain sessions and no Android-13-only keys (start() would fail on them)', () => {
    for (const api of [24, 30, 32]) {
      const options = startOptions('online', 'en-US', api);
      expect(options).toMatchObject({ continuous: false, requiresOnDeviceRecognition: false, interimResults: true });
      expect(options).not.toHaveProperty('androidIntentOptions');
    }
  });

  it('never keeps audio and never sends an empty language', () => {
    const options = startOptions('online', 'en-US', 34);
    expect(options).not.toHaveProperty('recordingOptions');
    expect(options).not.toHaveProperty('audioSource');
    expect(options.lang).toBe('en-US');
  });
});

describe('joinSegment', () => {
  it('joins finished stretches of speech with one space, tidying the recognizer’s spacing', () => {
    expect(joinSegment('', '  cells  divide ')).toBe('cells divide');
    expect(joinSegment('cells divide', 'by mitosis')).toBe('cells divide by mitosis');
    expect(joinSegment('cells divide ', 'by mitosis')).toBe('cells divide by mitosis');
    expect(joinSegment('cells divide\n', 'by mitosis')).toBe('cells divide\nby mitosis');
    expect(joinSegment('cells divide', '   ')).toBe('cells divide');
  });

  it('starts a new paragraph when the person picks up again after a pause, keeping their edits', () => {
    expect(joinSegment('Cells divide.', 'osmosis', true)).toBe('Cells divide.\n\nosmosis');
    expect(joinSegment('Cells divide.  ', 'osmosis', true)).toBe('Cells divide.\n\nosmosis');
    expect(joinSegment('Cells divide.\n', 'osmosis', true)).toBe('Cells divide.\n\nosmosis');
    expect(joinSegment('Cells divide.\n\n', 'osmosis', true)).toBe('Cells divide.\n\nosmosis');
    expect(joinSegment('', 'osmosis', true)).toBe('osmosis');
  });
});

describe('errors', () => {
  it('maps every code Android sends to what the loop does', () => {
    const cases: [string, number | undefined, string][] = [
      ['aborted', -1, 'ignore'],
      ['no-speech', 7, 'restart'],
      ['speech-timeout', 6, 'restart'],
      ['busy', 8, 'retry'],
      ['client', 5, 'retry'],
      ['not-allowed', -1, 'permission'],
      ['service-not-allowed', 9, 'permission'],
      ['network', 2, 'network'],
      ['network', 1, 'network'],
      ['network', 4, 'network'],
      ['network', 11, 'network'],
      ['language-not-supported', 12, 'language'],
      ['language-not-supported', 13, 'download'],
      ['audio-capture', 3, 'busy-mic'],
      ['audio-capture', -1, 'busy-mic'],
      ['too-many-requests', 10, 'stop'],
      ['unknown', undefined, 'stop'],
      ['something-new', 99, 'stop'],
    ];
    for (const [error, code, action] of cases) {
      expect([error, code, classifyError({ error: error as never, code })]).toEqual([error, code, action]);
    }
  });

  it('only the errors that stop dictation have a pause reason', () => {
    expect(pauseReasonFor('ignore')).toBeNull();
    expect(pauseReasonFor('restart')).toBeNull();
    expect(pauseReasonFor('retry')).toBeNull();
    expect(pauseReasonFor('network')).toBe('network');
    expect(pauseReasonFor('download')).toBe('download');
    expect(pauseReasonFor('stop')).toBe('error');
  });

  it('says every pause in plain words', () => {
    const reasons: (PauseReason | null)[] = [null, 'quiet', 'background', 'cap', 'service', 'network', 'language', 'download', 'permission', 'busy-mic', 'error'];
    for (const reason of reasons) expect(pauseMessage(reason, 'English (UK)').length).toBeGreaterThan(20);
    expect(pauseMessage('cap', 'English (UK)')).toContain('20,000 characters');
    expect(pauseMessage('language', 'English (India)')).toBe('This phone can’t turn English (India) speech into text. Choose another language, or type.');
    expect(pauseMessage('quiet', 'x')).toBe('Paused after a minute of quiet. Tap the mic to carry on.');
  });
});

describe('languages', () => {
  it('canonical tags as speech recognition takes them', () => {
    expect(canonicalTag('en_us')).toBe('en-US');
    expect(canonicalTag('zh-hant-tw')).toBe('zh-Hant-TW');
    expect(canonicalTag('es-419')).toBe('es-419');
    expect(canonicalTag('de-DE-u-co-phonebk')).toBe('de-DE');
    expect(canonicalTag('English')).toBeNull();
    expect(canonicalTag('')).toBeNull();
    expect(canonicalTag(null)).toBeNull();
  });

  it('the phone’s language unless one was chosen; plain English is US English', () => {
    expect(dictationLang(null, 'en-GB')).toBe('en-GB');
    expect(dictationLang('en-IN', 'en-GB')).toBe('en-IN');
    expect(dictationLang(null, 'de_DE')).toBe('de-DE');
    expect(dictationLang(null, 'en')).toBe('en-US');
    expect(dictationLang(null, null)).toBe('en-US');
    expect(dictationLang('bad tag!', 'fr-FR')).toBe('fr-FR');
  });

  it('English first, then the phone’s language, then what the service lists, without repeats', () => {
    expect(languageChoices('en-GB', [])).toEqual(['en-US', 'en-GB', 'en-AU', 'en-CA', 'en-IN', 'en-IE', 'en-NZ', 'en-ZA']);
    const choices = languageChoices('de-DE', ['fr-FR', 'en_US', 'de-DE', 'es-ES']);
    expect(choices.slice(0, 9)).toEqual(['en-US', 'en-GB', 'en-AU', 'en-CA', 'en-IN', 'en-IE', 'en-NZ', 'en-ZA', 'de-DE']);
    expect(choices.slice(9).sort()).toEqual(['es-ES', 'fr-FR']);
    expect(new Set(choices).size).toBe(choices.length);
  });

  it('names English variants plainly and falls back on the tag', () => {
    expect(languageName('en-GB')).toBe('English (UK)');
    expect(languageName('en-US')).toBe('English (US)');
    expect(languageName('xx-ZZ').length).toBeGreaterThan(0);
  });
});

describe('the rest', () => {
  it('limits: the note limit, a minute of quiet, 4 s to stop, three retries', () => {
    expect(DICTATION_LIMITS.maxChars).toBe(20_000);
    expect(DICTATION_LIMITS.quietPauseMs).toBe(60_000);
    expect(DICTATION_LIMITS.stopWatchdogMs).toBe(4_000);
    expect(DICTATION_LIMITS.retryDelaysMs).toEqual([300, 600, 1200]);
  });

  it('voice level from the volume event', () => {
    expect(levelFromVolume(-2)).toBe(0);
    expect(levelFromVolume(5)).toBe(0.5);
    expect(levelFromVolume(12)).toBe(1);
    expect(levelFromVolume(Number.NaN)).toBe(0);
  });
});
