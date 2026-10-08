/**
 * Input checks for the sign-in screens. They only catch obvious typos before a network round trip;
 * Supabase Auth is the real validator.
 */

/**
 * Supabase lets a project send email codes of 6 to 10 digits (Authentication → Email → "Email OTP
 * length"; supabase/config.toml uses 6). Accept the whole range, so a project whose dashboard is set
 * to a different length (8 has been seen) can still sign in.
 */
export const OTP_MIN_LENGTH = 6;
export const OTP_MAX_LENGTH = 10;

/** Trims and lower-cases, the form Supabase stores, so "Me@X.com " and "me@x.com" are one account. */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * A pragmatic shape check: one @, a non-empty local part, and a dotted domain without spaces.
 * Deliberately loose (RFC 5322 allows far more); it exists to catch "name@gmail" and stray spaces.
 */
export function isValidEmail(input: string): boolean {
  const email = normalizeEmail(input);
  if (email.length > 254) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email);
}

export function emailError(input: string): string | null {
  if (normalizeEmail(input) === '') return 'Enter your email address.';
  if (!isValidEmail(input)) return 'That doesn’t look like an email address. Check for typos.';
  return null;
}

/**
 * Keeps only digits, so a pasted "123 456" or "123-456" still works, and caps the length.
 */
export function normalizeCode(input: string): string {
  return input.replace(/\D/g, '').slice(0, OTP_MAX_LENGTH);
}

export function isValidCode(input: string): boolean {
  return new RegExp(`^\\d{${OTP_MIN_LENGTH},${OTP_MAX_LENGTH}}$`).test(input.trim());
}

export function codeError(input: string): string | null {
  const digits = normalizeCode(input);
  if (digits === '') return 'Enter the code from the email.';
  if (digits.length < OTP_MIN_LENGTH) return `The code has at least ${OTP_MIN_LENGTH} digits. Check the email.`;
  return null;
}
