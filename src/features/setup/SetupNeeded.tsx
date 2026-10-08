import { View } from 'react-native';

import { Card, Screen, Text } from '@/components';
import type { EnvVarName } from '@/lib/env';
import { useTheme } from '@/theme';

export type SetupNeededProps = {
  missing: readonly EnvVarName[];
  invalid: readonly EnvVarName[];
  reasons: Partial<Record<EnvVarName, string>>;
};

/**
 * Shown instead of the app when the build has no usable server settings (e.g. a fresh clone without
 * `.env`). The values are compiled into the bundle, so the fix always happens on the computer.
 */
export function SetupNeeded({ missing, invalid, reasons }: SetupNeededProps) {
  const { space } = useTheme();

  return (
    <Screen>
      <View style={{ gap: space[2] }}>
        <Text variant="headline">Setup needed</Text>
        <Text tone="secondary">
          This build doesn’t have its server settings yet, so it can’t sign in or sync. Nothing is wrong with your phone.
        </Text>
      </View>

      {missing.length > 0 ? (
        <Card>
          <Text variant="subtitle">Missing</Text>
          {missing.map((name) => (
            <Text key={name} variant="mono" selectable>
              {name}
            </Text>
          ))}
        </Card>
      ) : null}

      {invalid.length > 0 ? (
        <Card>
          <Text variant="subtitle">Needs fixing</Text>
          {invalid.map((name) => (
            <View key={name} style={{ gap: space[1] }}>
              <Text variant="mono" selectable>
                {name}
              </Text>
              <Text tone="danger">{reasons[name] ?? 'is not valid'}</Text>
            </View>
          ))}
        </Card>
      ) : null}

      <Card tint="mind">
        <Text variant="subtitle">How to fix it</Text>
        <Text>1. Copy .env.example to .env in the project folder.</Text>
        <Text>2. Fill in the values. docs/SETUP.md says where to find each one.</Text>
        <Text>3. Restart the dev server with: npx expo start --clear</Text>
        <Text tone="secondary">
          For EAS builds, set the same names as EAS environment variables, then build again.
        </Text>
      </Card>
    </Screen>
  );
}
