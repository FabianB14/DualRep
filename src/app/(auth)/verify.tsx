import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { codeError, normalizeCode, OTP_LENGTH } from '@/auth/validation';
import { Button, Screen, Text, TextField } from '@/components';
import { haptic, useTheme } from '@/theme';

/** Supabase allows one code email per address per 60 s by default, so the resend button waits as long. */
const RESEND_COOLDOWN_S = 60;

/** Seconds left on a countdown that restarts whenever `restart()` is called. */
function useCooldown(seconds: number): [number, () => void] {
  const [endsAt, setEndsAt] = useState(() => Date.now() + seconds * 1000);
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [endsAt]);
  return [left, () => setEndsAt(Date.now() + seconds * 1000)];
}

/** Step 2 of sign-in: type the code from the email. */
export default function VerifyScreen() {
  const { email } = useLocalSearchParams<{ email?: string }>();
  const { signInWithEmailCode, verifyEmailCode } = useAuth();
  const { space } = useTheme();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, restartCooldown] = useCooldown(RESEND_COOLDOWN_S);
  // The code auto-submits once complete; remember which one so a failed code is not retried in a loop.
  const lastSubmitted = useRef<string | null>(null);

  if (!email) return <Redirect href="/sign-in" />;

  const verify = async (candidate: string) => {
    if (verifying) return;
    const problem = codeError(candidate);
    if (problem) {
      setError(problem);
      haptic('error');
      return;
    }
    lastSubmitted.current = candidate;
    setVerifying(true);
    setError(null);
    setNotice(null);
    const result = await verifyEmailCode(email, normalizeCode(candidate));
    if (result.ok) {
      // The auth state change swaps this screen for the app (see the root layout's Stack.Protected).
      haptic('success');
      return;
    }
    setVerifying(false);
    setError(result.message);
    haptic('error');
  };

  const resend = async () => {
    setResending(true);
    setError(null);
    const result = await signInWithEmailCode(email);
    setResending(false);
    if (result.ok) {
      restartCooldown();
      setCode('');
      lastSubmitted.current = null;
      setNotice('New code sent. Use the newest email.');
      haptic('success');
    } else {
      setError(result.message);
      haptic('error');
    }
  };

  const minutes = Math.floor(cooldown / 60);
  const seconds = String(cooldown % 60).padStart(2, '0');

  return (
    <Screen
      footer={
        <>
          <Button label="Sign in" size="comfortable" loading={verifying} onPress={() => verify(code)} />
          <Button
            variant="ghost"
            label={cooldown > 0 ? `Send a new code in ${minutes}:${seconds}` : 'Send a new code'}
            disabled={cooldown > 0 || verifying}
            loading={resending}
            onPress={resend}
          />
          <Button
            variant="ghost"
            label="Use a different email"
            disabled={verifying}
            onPress={() => router.replace('/sign-in')}
          />
        </>
      }
    >
      <View style={{ gap: space[2], marginTop: space[8] }}>
        <Text variant="headline">Check your email</Text>
        <Text tone="secondary">
          We sent a {OTP_LENGTH}-digit code to <Text style={{ fontWeight: '600' }}>{email}</Text>. It can take a minute
          to arrive; check spam too.
        </Text>
      </View>
      <TextField
        label={`${OTP_LENGTH}-digit code`}
        value={code}
        onChangeText={(text) => {
          const digits = normalizeCode(text);
          setCode(digits);
          if (error) setError(null);
          if (digits.length === OTP_LENGTH && digits !== lastSubmitted.current) void verify(digits);
        }}
        error={error}
        hint={notice ?? undefined}
        large
        autoFocus
        keyboardType="number-pad"
        inputMode="numeric"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        returnKeyType="done"
        onSubmitEditing={() => verify(code)}
        editable={!verifying}
      />
    </Screen>
  );
}
