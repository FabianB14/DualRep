import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, useColorScheme } from 'react-native';

import {
  elevation,
  motion,
  palettes,
  radius,
  space,
  touch,
  typography,
  type ColorScheme,
  type Palette,
} from './tokens';

export type Theme = {
  scheme: ColorScheme;
  colors: Palette;
  space: typeof space;
  radius: typeof radius;
  touch: typeof touch;
  typography: typeof typography;
  motion: typeof motion;
  elevation: typeof elevation;
  /** The OS "remove animations" setting; see motionFor() in tokens.ts. */
  reduceMotion: boolean;
};

export function buildTheme(scheme: ColorScheme, reduceMotion = false): Theme {
  return {
    scheme,
    colors: palettes[scheme],
    space,
    radius,
    touch,
    typography,
    motion,
    elevation,
    reduceMotion,
  };
}

const ThemeContext = createContext<Theme | null>(null);

/** Follows the system light/dark setting (app.config: userInterfaceStyle 'automatic') and reduced motion. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const scheme: ColorScheme = systemScheme === 'dark' ? 'dark' : 'light';
  const reduceMotion = useReduceMotion();
  const theme = useMemo(() => buildTheme(scheme, reduceMotion), [scheme, reduceMotion]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('useTheme must be used inside <ThemeProvider>');
  return theme;
}

function useReduceMotion(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => {
        if (active) setEnabled(value);
      },
      () => undefined,
    );
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setEnabled);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return enabled;
}
