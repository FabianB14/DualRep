/**
 * Build-time configuration. Expo inlines `process.env.EXPO_PUBLIC_*` into the JS bundle when it is
 * built, so these values are public by definition: only the Supabase publishable (or legacy anon)
 * key and service URLs belong here — never a service-role key, a secret key or an AI provider key.
 *
 * The app must not crash when a value is missing or wrong (a fresh clone without `.env`), so this
 * module never throws: it reports what is missing or invalid and the root layout shows "Setup needed".
 */

export const ENV_VARS = {
  supabaseUrl: 'EXPO_PUBLIC_SUPABASE_URL',
  supabaseKey: 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  powersyncUrl: 'EXPO_PUBLIC_POWERSYNC_URL',
} as const;

export type EnvVarName = (typeof ENV_VARS)[keyof typeof ENV_VARS];

export type RawEnv = Partial<Record<EnvVarName, string | undefined>>;

export type Env =
  | { ok: true; supabaseUrl: string; supabaseKey: string; powersyncUrl: string }
  | {
      ok: false;
      missing: EnvVarName[];
      invalid: EnvVarName[];
      /** Plain-words reason for each invalid variable, shown on the Setup needed screen. */
      reasons: Partial<Record<EnvVarName, string>>;
    };

/**
 * Reads the variables. Each one must be written out as a literal `process.env.EXPO_PUBLIC_…` member
 * access: that is the only form Expo's Babel transform replaces with the value at build time.
 */
export function readRawEnv(): RawEnv {
  return {
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    EXPO_PUBLIC_POWERSYNC_URL: process.env.EXPO_PUBLIC_POWERSYNC_URL,
  };
}

export function readEnv(raw: RawEnv = readRawEnv()): Env {
  const missing: EnvVarName[] = [];
  const reasons: Partial<Record<EnvVarName, string>> = {};

  const take = (name: EnvVarName, check: (value: string) => string | null): string => {
    const value = raw[name]?.trim() ?? '';
    if (value === '') {
      missing.push(name);
      return '';
    }
    const problem = check(value);
    if (problem) reasons[name] = problem;
    return value;
  };

  const supabaseUrl = take(ENV_VARS.supabaseUrl, checkServiceUrl);
  const supabaseKey = take(ENV_VARS.supabaseKey, checkPublishableKey);
  const powersyncUrl = take(ENV_VARS.powersyncUrl, checkServiceUrl);

  const invalid = Object.keys(reasons) as EnvVarName[];
  if (missing.length > 0 || invalid.length > 0) return { ok: false, missing, invalid, reasons };
  // Trailing slashes are trimmed: PowerSync rejects an endpoint that ends in "/", and supabase-js
  // builds paths by concatenation.
  return { ok: true, supabaseUrl: trimSlashes(supabaseUrl), supabaseKey, powersyncUrl: trimSlashes(powersyncUrl) };
}

/** An http(s) origin with no path, query or fragment (a common mistake is pasting the REST URL). */
function checkServiceUrl(value: string): string | null {
  const match = /^(https?):\/\/([^/?#\s]+)(\/*)$/i.exec(value);
  if (!match) {
    return /^https?:\/\//i.test(value)
      ? 'must be just the base URL, with no path such as /rest/v1'
      : 'must start with https:// (or http:// for a local server)';
  }
  return null;
}

/**
 * Accepts the new `sb_publishable_…` key or a legacy anon JWT. Refuses keys that would hand every
 * install full database access: `sb_secret_…` keys and legacy JWTs whose role is service_role.
 */
function checkPublishableKey(value: string): string | null {
  if (value.startsWith('sb_secret_')) {
    return 'is a secret key; use the publishable key (sb_publishable_…) — secret keys must never ship in the app';
  }
  if (value.startsWith('sb_publishable_')) return null;
  const role = jwtRole(value);
  if (role === 'service_role') {
    return 'is the service_role key; use the anon or publishable key — service keys must never ship in the app';
  }
  if (role === null) return 'is not a Supabase publishable key (sb_publishable_…) or anon key';
  return null;
}

/** The `role` claim of a JWT, or null when the value is not a decodable JWT. */
function jwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const payload: unknown = JSON.parse(atob(padded));
    if (typeof payload !== 'object' || payload === null) return null;
    const role = (payload as { role?: unknown }).role;
    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
}

function trimSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}
