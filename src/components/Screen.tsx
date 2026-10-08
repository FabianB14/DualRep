import type { ReactNode } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';

export type ScreenProps = {
  children: ReactNode;
  /** Pinned to the bottom, outside the scroll area: where a screen's one primary action lives, so it
   * stays visible (and above the keyboard) however long the content is. */
  footer?: ReactNode;
  /** Scroll the content (default). Turn off for screens that manage their own layout. */
  scroll?: boolean;
  edges?: readonly Edge[];
};

/**
 * Page frame. Android 16 (target API 36) always draws edge-to-edge behind transparent status and
 * navigation bars, so content is inset with safe-area padding on every edge, for both gesture and
 * 3-button navigation. With edge-to-edge the window no longer resizes for the keyboard, so
 * KeyboardAvoidingView adds the padding itself on both platforms.
 */
export function Screen({ children, footer, scroll = true, edges = ['top', 'bottom', 'left', 'right'] }: ScreenProps) {
  const { colors, space } = useTheme();
  const contentStyle = { padding: space[5], gap: space[5] };

  return (
    <SafeAreaView edges={edges} style={[styles.fill, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        {scroll ? (
          <ScrollView
            style={styles.fill}
            contentContainerStyle={[contentStyle, styles.grow]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            {children}
          </ScrollView>
        ) : (
          <View style={[styles.fill, contentStyle]}>{children}</View>
        )}
        {footer ? (
          <View
            style={{
              paddingHorizontal: space[5],
              paddingTop: space[3],
              paddingBottom: space[4],
              gap: space[2],
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: colors.border,
              backgroundColor: colors.background,
            }}
          >
            {footer}
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flexGrow: 1 },
});
