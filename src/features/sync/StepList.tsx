import { View } from 'react-native';

import { Text } from '@/components';
import { useTheme } from '@/theme';

/**
 * The numbered steps of a flow. All steps stay visible so the user always knows what comes next;
 * the current one is highlighted, finished ones are checked off.
 */
export function StepList({ steps, current }: { steps: readonly { title: string }[]; current: number }) {
  const { colors, radius, space } = useTheme();

  return (
    <View accessibilityRole="list" style={{ gap: space[2] }}>
      {steps.map((step, index) => {
        const state = index < current ? 'done' : index === current ? 'current' : 'upcoming';
        const marker = state === 'done' ? '✓' : String(index + 1);
        return (
          <View
            key={step.title}
            accessible
            accessibilityLabel={`Step ${index + 1} of ${steps.length}: ${step.title}${
              state === 'done' ? ', done' : state === 'current' ? ', current step' : ''
            }`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space[3],
              paddingVertical: space[2],
              paddingHorizontal: space[3],
              borderRadius: radius.md,
              backgroundColor: state === 'current' ? colors.mind.subtle : 'transparent',
            }}
          >
            <View
              style={{
                width: 28,
                height: 28,
                borderRadius: 14,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: state === 'current' ? colors.mind.solid : state === 'done' ? colors.success.subtle : colors.surfaceMuted,
              }}
            >
              <Text
                variant="caption"
                style={{
                  fontWeight: '700',
                  color: state === 'current' ? colors.mind.onSolid : state === 'done' ? colors.success.text : colors.textSecondary,
                }}
              >
                {marker}
              </Text>
            </View>
            <Text
              tone={state === 'upcoming' ? 'secondary' : 'primary'}
              style={{ flex: 1, fontWeight: state === 'current' ? '600' : '400' }}
            >
              {step.title}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
