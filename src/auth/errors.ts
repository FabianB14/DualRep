/**
 * Turns Supabase Auth errors into short, plain-words messages that say what to do next. Kept pure
 * (structural input, no supabase-js import) so it is unit-tested without a client.
 */

export type AuthErrorLike = {
  message?: string;
  /** Supabase error code, e.g. 'otp_expired', 'over_email_send_rate_limit'. */
  code?: string;
  /** HTTP status; 0 or undefined when the request never got a response. */
  status?: number;
  name?: string;
};

export function authErrorMessage(error: AuthErrorLike | null | undefined): string {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code ?? '';
  const status = error.status;

  // Gateway errors also arrive as AuthRetryableFetchError, so check for a server status first.
  if (status !== undefined && status >= 500) {
    return 'The server had a problem. Please try again in a moment.';
  }
  // No HTTP response at all: airplane mode, no signal, DNS failure.
  if (error.name === 'AuthRetryableFetchError' || status === 0 || /network request failed|fetch failed/i.test(error.message ?? '')) {
    return 'No connection. Check your internet and try again.';
  }
  if (code === 'otp_expired') {
    return 'That code is wrong or has expired. Check the latest email, or send a new code.';
  }
  if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit' || status === 429) {
    return 'Too many tries. Wait a minute, then try again.';
  }
  if (code === 'email_address_not_authorized') {
    // Supabase's built-in mailer only sends to the project's team members until custom SMTP is set up.
    return 'This server can’t send email to that address yet. Ask the app’s admin to set up email sending.';
  }
  if (code === 'email_address_invalid' || code === 'validation_failed') {
    return 'That email address can’t be used. Check it and try again.';
  }
  if (code === 'signup_disabled' || code === 'otp_disabled' || code === 'email_provider_disabled') {
    return 'Email sign-in is turned off for this server.';
  }
  if (code === 'user_banned') {
    return 'This account is blocked. Contact support.';
  }
  return error.message ? `Couldn’t sign in: ${error.message}` : 'Something went wrong. Please try again.';
}
