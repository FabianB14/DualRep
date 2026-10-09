import type { ConfigContext, ExpoConfig } from 'expo/config';
import { withAndroidManifest, type ConfigPlugin } from 'expo/config-plugins';

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

// Launcher badge permissions that ShortcutBadger (inside expo-notifications) declares; DualRep never
// sets a badge count. The list is the one the CI preview build printed on 2026-10-08.
const LAUNCHER_BADGE_PERMISSIONS = [
  'android.permission.READ_APP_BADGE',
  'com.sec.android.provider.badge.permission.READ',
  'com.sec.android.provider.badge.permission.WRITE',
  'com.htc.launcher.permission.READ_SETTINGS',
  'com.htc.launcher.permission.UPDATE_SHORTCUT',
  'com.sonyericsson.home.permission.BROADCAST_BADGE',
  'com.sonymobile.home.permission.PROVIDER_INSERT_BADGE',
  'com.anddoes.launcher.permission.UPDATE_COUNT',
  'com.majeur.launcher.permission.UPDATE_BADGE',
  'com.huawei.android.launcher.permission.CHANGE_BADGE',
  'com.huawei.android.launcher.permission.READ_SETTINGS',
  'com.huawei.android.launcher.permission.WRITE_SETTINGS',
  'com.oppo.launcher.permission.READ_SETTINGS',
  'com.oppo.launcher.permission.WRITE_SETTINGS',
  'me.everything.badger.permission.BADGE_COUNT_READ',
  'me.everything.badger.permission.BADGE_COUNT_WRITE',
];

// Hardware features Google Play would otherwise treat as required because the app declares CAMERA
// (from expo-image-picker's library manifest): the <uses-feature> page's "permissions that imply
// features" table maps CAMERA to both. Taking a photo is optional in DualRep (the gallery and files
// work everywhere), so tablets and Chromebooks without a rear or autofocus camera can still install it.
const OPTIONAL_CAMERA_FEATURES = ['android.hardware.camera', 'android.hardware.camera.autofocus'] as const;

/**
 * Declares the camera features as `android:required="false"` (docs/ANDROID.md 2.7). A tiny inline
 * plugin rather than a package: it only touches <uses-feature>, and an entry that is already there
 * (from another plugin) is switched to not required instead of duplicated.
 */
const withOptionalCamera: ConfigPlugin = (config) =>
  withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    const features = (manifest['uses-feature'] ??= []);
    for (const feature of OPTIONAL_CAMERA_FEATURES) {
      const existing = features.find((entry) => entry.$['android:name'] === feature);
      if (existing) existing.$['android:required'] = 'false';
      else features.push({ $: { 'android:name': feature, 'android:required': 'false' } });
    }
    return mod;
  });

const { name, scheme, idSuffix } = IDENTITY[variant];
const projectId = process.env.EAS_PROJECT_ID;
const owner = process.env.EXPO_OWNER;

const buildConfig = ({ config }: ConfigContext): ExpoConfig => ({
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
      // Also asked for by expo-image-picker and expo-file-system (up to API 32). Photos come from the
      // system Photo Picker and documents from the system file picker, neither of which needs them.
      // One effect: below Android 10 (API 29) expo-image-picker's camera also asks for
      // WRITE_EXTERNAL_STORAGE, so the app hides "Take a photo" there (src/features/study/upload.ts).
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      // Blocked here, not with expo-image-picker's `microphonePermission: false` (which would block it
      // from the plugin, out of sight): audio study mode (Phase 2B) unblocks it by deleting this line.
      'android.permission.RECORD_AUDIO',
      // Phase 2: never broad photo or video access (Google Play's Photo and Video Permissions policy),
      // whatever a future library declares. The Photo Picker and the camera app need none of these.
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
      'android.permission.ACCESS_MEDIA_LOCATION',
      // expo-secure-store declares these for biometric-protected items; DualRep never uses them.
      'android.permission.USE_BIOMETRIC',
      'android.permission.USE_FINGERPRINT',
      // The development client's debug overlay draws over other apps, so only dev builds keep it.
      ...(variant === 'development' ? [] : ['android.permission.SYSTEM_ALERT_WINDOW']),
      // expo-notifications bundles Firebase push, Google's install referrer (through expo-application)
      // and ShortcutBadger. Phase 1 uses local notifications only: no push until Phase 4 (unblock
      // c2dm.RECEIVE then), no install-referrer lookups, and no launcher badge counts.
      'com.google.android.c2dm.permission.RECEIVE',
      'com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE',
      ...LAUNCHER_BADGE_PERMISSIONS,
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
    [
      // Phase 1: the end-of-block alert is a scheduled local notification (docs/ANDROID.md 1.1, D8).
      // Adds POST_NOTIFICATIONS and RECEIVE_BOOT_COMPLETED (pending alerts survive a reboot). No exact
      // alarms yet (1.3) and never USE_EXACT_ALARM.
      'expo-notifications',
      {
        // White silhouette on transparent (Android tints it); the mind accent from src/theme/tokens.ts.
        icon: './assets/notification-icon.png',
        color: '#3A55A4',
      },
    ],
    [
      // Phase 2: photos of handwritten notes (docs/ANDROID.md 2.7). Its library manifest adds CAMERA,
      // which "Take a photo" asks for in context, the only permission Phase 2 adds; picking from the
      // gallery uses the system Photo Picker and needs none. This plugin would run even unlisted (an
      // Expo "legacy" plugin); listing it keeps its options in one visible place. Its default adds
      // RECORD_AUDIO, which blockedPermissions above removes. The strings are iOS-only.
      'expo-image-picker',
      {
        photosPermission: 'DualRep opens your photos when you add pictures of your notes.',
        cameraPermission: 'DualRep uses the camera when you photograph your notes.',
      },
    ],
    // expo-document-picker (PDF and Word files) needs no entry: it asks for no permission, and its
    // plugin (iOS iCloud only) runs automatically. expo-image-manipulator and expo-file-system need
    // none either.
    // No expo-audio plugin yet: its defaults add a media foreground service and microphone access
    // (docs/ANDROID.md 2.2). It comes with audio study mode (Phase 2B).
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

export default (context: ConfigContext): ExpoConfig => withOptionalCamera(buildConfig(context));
