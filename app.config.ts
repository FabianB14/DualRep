import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * DualRep app config (Expo SDK 57). One codebase, three installable variants chosen by APP_VARIANT
 * (set per EAS build profile in eas.json; defaults to production so a bare `expo` command can never
 * produce a build that looks like production but isn't):
 * - development: dev client, can sit next to the other two on one phone;
 * - preview: internal release build, for testers;
 * - production: the Play Store app.
 */
type Variant = 'development' | 'preview' | 'production';

const VARIANTS: readonly Variant[] = ['development', 'preview', 'production'];

function readVariant(): Variant {
  const raw = process.env.APP_VARIANT;
  if (raw === undefined || raw === '') return 'production';
  if ((VARIANTS as readonly string[]).includes(raw)) return raw as Variant;
  throw new Error(`APP_VARIANT must be one of ${VARIANTS.join(', ')} (got "${raw}")`);
}

const variant = readVariant();

const IDENTITY: Record<Variant, { name: string; scheme: string; idSuffix: string }> = {
  development: { name: 'DualRep (dev)', scheme: 'dualrep-dev', idSuffix: '.dev' },
  preview: { name: 'DualRep (preview)', scheme: 'dualrep-preview', idSuffix: '.preview' },
  production: { name: 'DualRep', scheme: 'dualrep', idSuffix: '' },
};

// Background of the splash screen and adaptive icon; matches the theme's light/dark canvas
// (src/theme/tokens.ts) so launch flows straight into the first screen without a color jump.
const CANVAS_LIGHT = '#F5F4F0';
const CANVAS_DARK = '#14171B';

const { name, scheme, idSuffix } = IDENTITY[variant];
const projectId = process.env.EAS_PROJECT_ID;
const owner = process.env.EXPO_OWNER;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name,
  slug: 'dualrep',
  ...(owner ? { owner } : {}),
  version: '0.1.0',
  scheme,
  // Android 16 (target API 36) ignores orientation locks on screens ≥ 600 dp (tablets, foldables), so
  // every screen must still lay out correctly in landscape there; phones stay portrait.
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  // Placeholder art from the Expo template; DualRep brand icons are pending.
  icon: './assets/icon.png',
  android: {
    package: `com.interverse.dualrep${idSuffix}`,
    adaptiveIcon: {
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
      backgroundColor: CANVAS_LIGHT,
    },
    // Keep the auth session and local database out of Android cloud backups: a restored copy on
    // another phone would carry a stale refresh token and a stale upload queue.
    allowBackup: false,
    // Expo writes enableOnBackInvokedCallback="false"; react-native-screens' support for predictive
    // back is still opt-in. Revisit on each SDK upgrade.
    predictiveBackGestureEnabled: false,
    // `permissions` can only add; `blockedPermissions` writes tools:node="remove" so permissions
    // merged in by the template or libraries never reach the manifest.
    blockedPermissions: [
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.RECORD_AUDIO',
      // expo-secure-store declares these for biometric-protected items; DualRep never uses them.
      'android.permission.USE_BIOMETRIC',
      'android.permission.USE_FINGERPRINT',
      // The development client's debug overlay draws over other apps, so only dev builds keep it.
      ...(variant === 'development' ? [] : ['android.permission.SYSTEM_ALERT_WINDOW']),
    ],
  },
  ios: {
    bundleIdentifier: `com.interverse.dualrep${idSuffix}`,
    supportsTablet: true,
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-splash-screen',
      {
        // Placeholder art from the Expo template; DualRep brand art is pending.
        image: './assets/splash-icon.png',
        imageWidth: 200,
        resizeMode: 'contain',
        backgroundColor: CANVAS_LIGHT,
        dark: { image: './assets/splash-icon.png', backgroundColor: CANVAS_DARK },
      },
    ],
    [
      'expo-build-properties',
      {
        // SDK levels stay at the Expo 57 defaults (compileSdk 36, targetSdk 36, minSdk 24).
        // R8 minification/resource shrinking stays off until every native module (PowerSync, op-sqlite,
        // Reanimated) has been verified in a minified release build; a missing keep rule would only
        // show up as a crash on a tester's phone.
        android: {},
      },
    ],
    // No expo-notifications or expo-audio plugin in Phase 0: they add permissions, receivers and
    // foreground services (with Play Console declarations) that the foundation does not use.
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    ...config.extra,
    appVariant: variant,
    ...(projectId ? { eas: { projectId } } : {}),
  },
});
