/**
 * English names for the languages the notes screen offers, so its list says "German (Germany)", not
 * "de-DE". Hermes, the phone's JavaScript engine, has no Intl.DisplayNames (its Intl has only Collator,
 * NumberFormat and DateTimeFormat), so DualRep keeps its own: the languages Android's speech services
 * list and the regions and scripts in their tags. The names are the ones Node's ICU gives in English
 * (Intl.DisplayNames with languageDisplay 'standard'), so the phone and the tests show the same.
 */

/** Languages (with the old codes Android still uses: iw = he, in = id, tl = fil; cmn is Mandarin). */
const LANGUAGES: Readonly<Record<string, string>> = {
  af: 'Afrikaans', am: 'Amharic', ar: 'Arabic', as: 'Assamese', az: 'Azerbaijani', be: 'Belarusian',
  bg: 'Bulgarian', bn: 'Bangla', bs: 'Bosnian', ca: 'Catalan', cmn: 'Chinese', cs: 'Czech', cy: 'Welsh',
  da: 'Danish', de: 'German', el: 'Greek', en: 'English', es: 'Spanish', et: 'Estonian', eu: 'Basque',
  fa: 'Persian', fi: 'Finnish', fil: 'Filipino', fr: 'French', ga: 'Irish', gl: 'Galician', gu: 'Gujarati',
  he: 'Hebrew', hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian', hy: 'Armenian', id: 'Indonesian',
  in: 'Indonesian', is: 'Icelandic', it: 'Italian', iw: 'Hebrew', ja: 'Japanese', jv: 'Javanese',
  ka: 'Georgian', kk: 'Kazakh', km: 'Khmer', kn: 'Kannada', ko: 'Korean', ky: 'Kyrgyz', lb: 'Luxembourgish',
  lo: 'Lao', lt: 'Lithuanian', lv: 'Latvian', mk: 'Macedonian', ml: 'Malayalam', mn: 'Mongolian',
  mr: 'Marathi', ms: 'Malay', mt: 'Maltese', my: 'Burmese', nb: 'Norwegian Bokmål', ne: 'Nepali', nl: 'Dutch',
  nn: 'Norwegian Nynorsk', no: 'Norwegian', or: 'Odia', pa: 'Punjabi', pl: 'Polish', ps: 'Pashto',
  pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', rw: 'Kinyarwanda', si: 'Sinhala', sk: 'Slovak',
  sl: 'Slovenian', so: 'Somali', sq: 'Albanian', sr: 'Serbian', ss: 'Swati', st: 'Southern Sotho',
  su: 'Sundanese', sv: 'Swedish', sw: 'Swahili', ta: 'Tamil', te: 'Telugu', tg: 'Tajik', th: 'Thai',
  tk: 'Turkmen', tl: 'Filipino', tn: 'Tswana', tr: 'Turkish', ts: 'Tsonga', uk: 'Ukrainian', ur: 'Urdu',
  uz: 'Uzbek', ve: 'Venda', vi: 'Vietnamese', xh: 'Xhosa', yue: 'Cantonese', zh: 'Chinese', zu: 'Zulu',
};

/** Scripts, as they appear in tags like zh-Hant-TW. */
const SCRIPTS: Readonly<Record<string, string>> = {
  Arab: 'Arabic', Cyrl: 'Cyrillic', Guru: 'Gurmukhi', Hans: 'Simplified', Hant: 'Traditional', Latn: 'Latin',
};

/** Regions (419 = Latin America). */
const REGIONS: Readonly<Record<string, string>> = {
  '419': 'Latin America', AE: 'United Arab Emirates', AL: 'Albania', AM: 'Armenia', AR: 'Argentina',
  AT: 'Austria', AU: 'Australia', AZ: 'Azerbaijan', BA: 'Bosnia & Herzegovina', BD: 'Bangladesh',
  BE: 'Belgium', BG: 'Bulgaria', BH: 'Bahrain', BO: 'Bolivia', BR: 'Brazil', BY: 'Belarus', CA: 'Canada',
  CH: 'Switzerland', CL: 'Chile', CN: 'China', CO: 'Colombia', CR: 'Costa Rica', CY: 'Cyprus', CZ: 'Czechia',
  DE: 'Germany', DK: 'Denmark', DO: 'Dominican Republic', DZ: 'Algeria', EC: 'Ecuador', EE: 'Estonia',
  EG: 'Egypt', ES: 'Spain', ET: 'Ethiopia', FI: 'Finland', FR: 'France', GB: 'United Kingdom', GE: 'Georgia',
  GH: 'Ghana', GR: 'Greece', GT: 'Guatemala', HK: 'Hong Kong SAR China', HN: 'Honduras', HR: 'Croatia',
  HU: 'Hungary', ID: 'Indonesia', IE: 'Ireland', IL: 'Israel', IN: 'India', IQ: 'Iraq', IR: 'Iran',
  IS: 'Iceland', IT: 'Italy', JO: 'Jordan', JP: 'Japan', KE: 'Kenya', KG: 'Kyrgyzstan', KH: 'Cambodia',
  KR: 'South Korea', KW: 'Kuwait', KZ: 'Kazakhstan', LA: 'Laos', LB: 'Lebanon', LK: 'Sri Lanka',
  LT: 'Lithuania', LU: 'Luxembourg', LV: 'Latvia', MA: 'Morocco', MK: 'North Macedonia',
  MM: 'Myanmar (Burma)', MN: 'Mongolia', MO: 'Macao SAR China', MT: 'Malta', MX: 'Mexico', MY: 'Malaysia',
  NG: 'Nigeria', NI: 'Nicaragua', NL: 'Netherlands', NO: 'Norway', NP: 'Nepal', NZ: 'New Zealand', OM: 'Oman',
  PA: 'Panama', PE: 'Peru', PH: 'Philippines', PK: 'Pakistan', PL: 'Poland', PR: 'Puerto Rico',
  PS: 'Palestinian Territories', PT: 'Portugal', PY: 'Paraguay', QA: 'Qatar', RO: 'Romania', RS: 'Serbia',
  RU: 'Russia', RW: 'Rwanda', SA: 'Saudi Arabia', SE: 'Sweden', SG: 'Singapore', SI: 'Slovenia',
  SK: 'Slovakia', SO: 'Somalia', SV: 'El Salvador', SY: 'Syria', TH: 'Thailand', TJ: 'Tajikistan',
  TM: 'Turkmenistan', TN: 'Tunisia', TR: 'Türkiye', TW: 'Taiwan', TZ: 'Tanzania', UA: 'Ukraine', UG: 'Uganda',
  US: 'United States', UY: 'Uruguay', UZ: 'Uzbekistan', VE: 'Venezuela', VN: 'Vietnam', YE: 'Yemen',
  ZA: 'South Africa', ZW: 'Zimbabwe',
};

/**
 * A language tag's name from these lists, e.g. "Chinese (Traditional, Taiwan)". `complete` is false
 * when a script or region isn't listed (it is then shown as it is, "German (LI)"); null when the
 * language itself isn't.
 */
export function languageNameFromList(tag: string): { name: string; complete: boolean } | null {
  const [language, ...rest] = tag.split('-');
  const name = LANGUAGES[language];
  if (!name) return null;
  if (rest.length === 0) return { name, complete: true };
  const parts = rest.map((part) => SCRIPTS[part] ?? REGIONS[part] ?? null);
  return {
    name: `${name} (${parts.map((part, k) => part ?? rest[k]).join(', ')})`,
    complete: parts.every((part) => part !== null),
  };
}
