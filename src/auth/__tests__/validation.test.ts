import { describe, expect, it } from '@jest/globals';

import { authErrorMessage } from '../errors';
import {
  codeError,
  emailError,
  isValidCode,
  isValidEmail,
  normalizeCode,
  normalizeEmail,
  OTP_MAX_LENGTH,
  OTP_MIN_LENGTH,
} from '../validation';

describe('email', () => {
  it.each(['me@example.com', ' Me@Example.COM ', 'first.last+tag@sub.domain.co.uk', 'a@b.io'])(
    'accepts %p',
    (email) => {
      expect(isValidEmail(email)).toBe(true);
      expect(emailError(email)).toBeNull();
    },
  );

  it.each(['', 'me', 'me@', '@example.com', 'me@example', 'me@exa mple.com', 'me@@example.com', 'me@example.', 'me@.com'])(
    'rejects %p',
    (email) => {
      expect(isValidEmail(email)).toBe(false);
      expect(emailError(email)).not.toBeNull();
    },
  );

  it('normalizes case and whitespace', () => {
    expect(normalizeEmail('  Me@Example.COM\n')).toBe('me@example.com');
  });

  it('asks for an email when empty, and for a fix when malformed', () => {
    expect(emailError('  ')).toBe('Enter your email address.');
    expect(emailError('me@gmail')).toMatch(/doesn’t look like an email/);
  });

  it('rejects absurdly long addresses', () => {
    expect(isValidEmail(`${'a'.repeat(250)}@example.com`)).toBe(false);
  });
});

describe('one-time code', () => {
  it('accepts every length Supabase can send (6 to 10 digits; supabase/config.toml uses 6)', () => {
    expect([OTP_MIN_LENGTH, OTP_MAX_LENGTH]).toEqual([6, 10]);
  });

  it.each(['123456', '000000', ' 987654 ', '12345678', '1234567890'])('accepts %p', (code) => {
    expect(isValidCode(code)).toBe(true);
  });

  it.each(['', '12345', '12345678901', '12345a', '12 3456'])('rejects %p', (code) => {
    expect(isValidCode(code)).toBe(false);
  });

  it('strips separators from pasted codes and caps the length', () => {
    expect(normalizeCode('123 456')).toBe('123456');
    expect(normalizeCode('123-456')).toBe('123456');
    expect(normalizeCode('Your code: 12345678')).toBe('12345678');
    expect(normalizeCode('123456789012')).toBe('1234567890');
  });

  it('explains what is wrong', () => {
    expect(codeError('')).toMatch(/code from the email/);
    expect(codeError('123')).toMatch(/at least 6 digits/);
    expect(codeError('12345678')).toBeNull();
    expect(codeError('123 456')).toBeNull();
  });
});

describe('authErrorMessage', () => {
  it.each([
    [{ name: 'AuthRetryableFetchError', message: 'Network request failed', status: 0 }, /No connection/],
    [{ message: 'Token has expired or is invalid', code: 'otp_expired', status: 403 }, /wrong or has expired/],
    [{ message: 'rate limited', code: 'over_email_send_rate_limit', status: 429 }, /Wait a minute/],
    [{ message: 'boom', status: 500 }, /server had a problem/],
    [{ name: 'AuthRetryableFetchError', message: 'Bad gateway', status: 502 }, /server had a problem/],
    [{ message: 'not authorized', code: 'email_address_not_authorized', status: 400 }, /can’t send email/],
    [{ message: 'Signups not allowed', code: 'signup_disabled', status: 422 }, /turned off/],
    [{ message: 'Odd failure', status: 400 }, /Couldn’t sign in: Odd failure/],
  ])('maps %p', (error, expected) => {
    expect(authErrorMessage(error)).toMatch(expected);
  });

  it('has a fallback for a missing error', () => {
    expect(authErrorMessage(null)).toMatch(/try again/);
  });
});
