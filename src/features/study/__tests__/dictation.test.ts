import { afterEach, describe, expect, it } from '@jest/globals';

import {
  canonicalTag,
  classifyError,
  DICTATION_LIMITS,
  dictationLang,
  fitSegment,
  joinSegment,
  languageChoices,
  languageName,
  levelFromVolume,
  localeMatches,
  pauseMessage,
  pauseReasonFor,
  pickEngine,
  speechServiceName,
  startOptions,
  type EngineInputs,
  type PauseReason,
} from '../dictation';
import { cleanStudyText } from '../studyApi';
import { validateText } from '../upload';

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

describe('fitSegment', () => {
  it('joins like joinSegment while the notes have room', () => {
    expect(fitSegment('cells divide', 'by mitosis', false, 100)).toEqual({ text: 'cells divide by mitosis', overflow: '' });
    expect(fitSegment('Cells divide.', 'osmosis', true, 100)).toEqual({ text: 'Cells divide.\n\nosmosis', overflow: '' });
    // Exactly at the limit still fits.
    expect(fitSegment('abcd', 'efgh', false, 9)).toEqual({ text: 'abcd efgh', overflow: '' });
  });

  it('past the limit, keeps the words that fit and hands back the rest, cut between words', () => {
    expect(fitSegment('abcd', 'ef gh ij', false, 10)).toEqual({ text: 'abcd ef gh', overflow: 'ij' });
    expect(fitSegment('abcd', 'ef gh ij', false, 9)).toEqual({ text: 'abcd ef', overflow: 'gh ij' });
    // Not even the first word fits (a new paragraph would need 2 more characters).
    expect(fitSegment('abcd', 'efghij', true, 9)).toEqual({ text: 'abcd', overflow: 'efghij' });
    // A language written without spaces moves as one stretch.
    expect(fitSegment('abcd', '細胞分裂です', false, 8)).toEqual({ text: 'abcd', overflow: '細胞分裂です' });
  });

  it('counts as Add to plan does: after cleaning, at the real note limit', () => {
    const notes = 'x'.repeat(DICTATION_LIMITS.maxChars - 30);
    const segment = 'and that is the end of the lecture on mitosis and meiosis';
    const { text, overflow } = fitSegment(notes, segment, true);
    expect(cleanStudyText(text).length).toBeLessThanOrEqual(DICTATION_LIMITS.maxChars);
    expect(() => validateText(text)).not.toThrow();
    // Every word is somewhere, in order.
    expect(`${text.slice(notes.length + 2)} ${overflow}`).toBe(segment);
    expect(overflow).not.toBe('');
  });

  it('leaves notes that are already over the limit (typed or pasted) as they are', () => {
    expect(fitSegment('abcdefghij', 'more words', false, 5)).toEqual({ text: 'abcdefghij', overflow: 'more words' });
    expect(fitSegment('abcdefghij', '  ', false, 5)).toEqual({ text: 'abcdefghij', overflow: '' });
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
      // The speech service's own permission, not DualRep's (the library sends not-allowed for that).
      ['service-not-allowed', 9, 'service-permission'],
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
    expect(pauseReasonFor('service-permission')).toBe('service-permission');
    expect(pauseReasonFor('download')).toBe('download');
    expect(pauseReasonFor('stop')).toBe('error');
  });

  it('says every pause in plain words', () => {
    const reasons: (PauseReason | null)[] = [
      null,
      'quiet',
      'background',
      'cap',
      'service',
      'network',
      'language',
      'download',
      'permission',
      'service-permission',
      'busy-mic',
      'error',
    ];
    for (const reason of reasons) expect(pauseMessage(reason, 'English (UK)').length).toBeGreaterThan(20);
    expect(pauseMessage('cap', 'English (UK)')).toContain('20,000 characters');
    expect(pauseMessage('language', 'English (India)')).toBe('This phone can’t turn English (India) speech into text. Choose another language, or type.');
    expect(pauseMessage('quiet', 'x')).toBe('Paused after a minute of quiet. Tap the mic to carry on.');
  });

  it('at the limit says to add the notes, unless they are over it (then: shorten them)', () => {
    expect(pauseMessage('cap', 'x')).toBe('That’s the most one set of notes can hold (20,000 characters). Add it to the plan, then start another.');
    const over = pauseMessage('cap', 'x', { over: true });
    expect(over).toBe('These notes are over 20,000 characters, the most one set can hold. Shorten them, then add them to the plan.');
    expect(over).not.toContain('Add it to the plan');
  });

  it('the speech service without the microphone: names it when known, and never says DualRep needs it', () => {
    expect(speechServiceName('com.google.android.googlequicksearchbox')).toBe('the Google app');
    expect(speechServiceName('com.google.android.tts')).toBe('Speech Services by Google');
    expect(speechServiceName('com.example.speech')).toBeNull();
    expect(speechServiceName('')).toBeNull();
    const named = pauseMessage('service-permission', 'x', { service: 'the Google app' });
    expect(named).toBe(
      'The phone’s speech service (the Google app) isn’t allowed to use the microphone, so it can’t hear you. Allow the microphone for the Google app in system settings, then tap the mic to try again. You can still type.',
    );
    const unnamed = pauseMessage('service-permission', 'x');
    expect(unnamed).toContain('The phone’s speech service isn’t allowed to use the microphone');
    for (const message of [named, unnamed]) {
      expect(message).not.toContain('DualRep');
      expect(message).not.toContain('asked again');
    }
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

  describe('on Hermes, which has no Intl.DisplayNames', () => {
    const intl = Intl as unknown as { DisplayNames?: unknown };
    const displayNames = intl.DisplayNames;
    afterEach(() => {
      intl.DisplayNames = displayNames;
    });

    it('names the languages speech services list from DualRep’s own list, not as codes', () => {
      delete intl.DisplayNames;
      expect(languageName('de-DE')).toBe('German (Germany)');
      expect(languageName('fr-FR')).toBe('French (France)');
      expect(languageName('es-419')).toBe('Spanish (Latin America)');
      expect(languageName('pt-BR')).toBe('Portuguese (Brazil)');
      expect(languageName('zh-Hant-TW')).toBe('Chinese (Traditional, Taiwan)');
      expect(languageName('cmn-Hans-CN')).toBe('Chinese (Simplified, China)');
      expect(languageName('iw-IL')).toBe('Hebrew (Israel)');
      expect(languageName('en-PH')).toBe('English (Philippines)');
      expect(languageName('ja')).toBe('Japanese');
      // A region the list lacks is shown as it is; an unknown language stays a code.
      expect(languageName('de-LI')).toBe('German (LI)');
      expect(languageName('xx-ZZ')).toBe('xx-ZZ');
    });

    it('sorts the other languages by those names', () => {
      delete intl.DisplayNames;
      const choices = languageChoices('en-GB', ['fr-FR', 'de-DE', 'es-ES', 'nl-NL']);
      expect(choices.slice(8).map(languageName)).toEqual(['Dutch (Netherlands)', 'French (France)', 'German (Germany)', 'Spanish (Spain)']);
    });

    it('gives the same names where Intl.DisplayNames exists (the tests’ Node, a later Hermes)', () => {
      const tags = ['de-DE', 'es-419', 'zh-Hant-TW', 'fr-CA', 'yue-Hant-HK', 'sr-Latn-RS'];
      const withIntl = tags.map(languageName);
      delete intl.DisplayNames;
      expect(tags.map(languageName)).toEqual(withIntl);
    });
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
