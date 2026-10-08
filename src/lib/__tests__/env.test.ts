import { describe, expect, it } from '@jest/globals';

import { readEnv, type RawEnv } from '../env';

/** A JWT-shaped string with the given payload (signature is irrelevant to the check). */
function fakeJwt(payload: object): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

const VALID: RawEnv = {
  EXPO_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abc123',
  EXPO_PUBLIC_POWERSYNC_URL: 'https://0123456789abcdef.powersync.journeyapps.com',
};

describe('readEnv', () => {
  it('accepts a complete configuration', () => {
    expect(readEnv(VALID)).toEqual({
      ok: true,
      supabaseUrl: 'https://abcdefghijklmnop.supabase.co',
      supabaseKey: 'sb_publishable_abc123',
      powersyncUrl: 'https://0123456789abcdef.powersync.journeyapps.com',
    });
  });

  it('reports every missing variable, treating blank values as missing', () => {
    const env = readEnv({ EXPO_PUBLIC_SUPABASE_URL: '   ', EXPO_PUBLIC_POWERSYNC_URL: VALID.EXPO_PUBLIC_POWERSYNC_URL });
    expect(env).toMatchObject({
      ok: false,
      missing: ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY'],
      invalid: [],
    });
  });

  it('reports everything missing for an empty environment (fresh clone, no .env)', () => {
    const env = readEnv({});
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.missing).toHaveLength(3);
  });

  it('trims whitespace and trailing slashes from URLs', () => {
    const env = readEnv({
      ...VALID,
      EXPO_PUBLIC_SUPABASE_URL: ' https://abcdefghijklmnop.supabase.co/ ',
      EXPO_PUBLIC_POWERSYNC_URL: 'https://0123456789abcdef.powersync.journeyapps.com//',
    });
    expect(env).toMatchObject({
      ok: true,
      supabaseUrl: 'https://abcdefghijklmnop.supabase.co',
      powersyncUrl: 'https://0123456789abcdef.powersync.journeyapps.com',
    });
  });

  it('allows plain http for a local Supabase / PowerSync during development', () => {
    const env = readEnv({
      ...VALID,
      EXPO_PUBLIC_SUPABASE_URL: 'http://192.168.1.20:54321',
      EXPO_PUBLIC_POWERSYNC_URL: 'http://10.0.2.2:8080',
    });
    expect(env.ok).toBe(true);
  });

  it.each([
    ['abcdefghijklmnop.supabase.co', 'must start with https://'],
    ['ftp://abcdefghijklmnop.supabase.co', 'must start with https://'],
    ['https://abcdefghijklmnop.supabase.co/rest/v1', 'no path'],
    ['https://abcdefghijklmnop.supabase.co?x=1', 'no path'],
  ])('rejects the URL %s', (url, reason) => {
    const env = readEnv({ ...VALID, EXPO_PUBLIC_SUPABASE_URL: url });
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.invalid).toEqual(['EXPO_PUBLIC_SUPABASE_URL']);
      expect(env.reasons.EXPO_PUBLIC_SUPABASE_URL).toContain(reason);
    }
  });

  it('accepts a legacy anon JWT', () => {
    const env = readEnv({ ...VALID, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: fakeJwt({ role: 'anon', iss: 'supabase' }) });
    expect(env.ok).toBe(true);
  });

  it.each([
    ['a secret key', 'sb_secret_abc123', 'secret key'],
    ['a legacy service_role JWT', fakeJwt({ role: 'service_role', iss: 'supabase' }), 'service_role'],
    ['something that is not a key', 'not-a-key', 'not a Supabase publishable key'],
  ])('refuses %s', (_label, key, reason) => {
    const env = readEnv({ ...VALID, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key });
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.invalid).toEqual(['EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY']);
      expect(env.reasons.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toContain(reason);
    }
  });
});
