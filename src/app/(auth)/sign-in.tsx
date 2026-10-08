import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { emailError, normalizeEmail } from '@/auth/validation';
import { Button, Screen, Text, TextField } from '@/components';
import { haptic, useTheme } from '@/theme';

/** Step 1 of sign-in: enter an email address and get a one-time code. */
export default function SignInScreen() {
  const { signInWithEmailCode } = useAuth();
  const { space } = useTheme();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (sending) return;
    const problem = emailError(email);
    if (problem) {
      setError(problem);
      haptic('error');
      return;
    }
    setSending(true);
    setError(null);
    const result = await signInWithEmailCode(email);
    setSending(false);
    if (!result.ok) {
      setError(result.message);
      haptic('error');
      return;
    }
    router.push({ pathname: '/verify', params: { email: normalizeEmail(email) } });
  };

  return (
    <Screen footer={<Button label="Send code" size="comfortable" loading={sending} onPress={send} />}>
      <View style={{ gap: space[2], marginTop: space[8] }}>
        <Text variant="caption" tone="mind" style={{ fontWeight: '600' }}>
          DualRep
        </Text>
        <Text variant="headline">Sign in</Text>
        <Text tone="secondary">We’ll email you a sign-in code. No password needed.</Text>
      </View>
      <TextField
        label="Email address"
        value={email}
        onChangeText={(text) => {
          setEmail(text);
          if (error) setError(null);
        }}
        error={error}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="emailAddress"
        keyboardType="email-address"
        inputMode="email"
        returnKeyType="send"
        onSubmitEditing={send}
        editable={!sending}
      />
    </Screen>
  );
}
