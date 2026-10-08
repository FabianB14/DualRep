# Android checklist by roadmap phase (research report)

> Research date: 2026-10-08. Reference copy of a Phase 0 research report, kept as background. Where it disagrees with the repo (migration, sync config, code) or with the guides in `docs/`, the repo and the guides win.
> The actionable guide built from this report is [ANDROID.md](../ANDROID.md).

**What could and couldn't be reached.** During research, **developer.android.com**, the **npm registry** and **Maven Central** were reachable, so the Expo, React Native, RevenueCat and Meta artifacts were checked directly. **support.google.com (Play policy), docs.expo.dev / expo.dev, revenuecat.com and meta.com could not be opened.** Claims from those sites come from search-result excerpts and are tagged as such.

**Tags used:**
- **[V]** I read it on the primary page during this research.
- **[P]** I confirmed it by unpacking the published npm or Maven artifact.
- **[S]** It comes from a search excerpt or a secondary source, because the primary page could not be opened.
- **[I]** It is my inference or general knowledge. Confirm before relying on it.

---

### Snapshot: the numbers that matter today

| Topic | State on 2026-10-08 | Tag / source |
|---|---|---|
| **Play target API** | New apps and updates must target **Android 16 (API 36)**, in force since **Aug 31, 2026**. An extension to **Nov 1, 2026** can be requested. Existing apps must target ≥35 to stay visible to new users on newer OS versions. **No API 37 deadline is published yet.** The yearly pattern suggests API 37 by about Aug 31, 2027. | [V] https://developer.android.com/google/play/requirements/target-sdk (page updated 2026-10-01); next deadline [I] |
| **Expo stable SDK** | `expo@57.0.27` (dist-tag `latest`), **React Native 0.86.3**, React 19.2.3. Android values come from RN's version catalog: **compileSdk 36, targetSdk 36, minSdk 24, buildTools 36.0.0, NDK 27.1.12297006, AGP 8.12.0, Kotlin 2.1.20**. The template uses Gradle **9.3.1**. | [P] `expo/bundledNativeModules.json`, `react-native@0.86.3/gradle/libs.versions.toml`, `expo-modules-autolinking` `ExpoRootProjectPlugin.kt`, `expo-template-bare-minimum@57.0.29` |
| **Expo SDK 58** | Beta (dist-tag `next`, 58.0.6), built on RN **0.88.0-rc**. Its catalog has **compileSdk 37 / targetSdk 36**, AGP **9.2.1** and Kotlin **2.2.0**. RN 0.88 stable is scheduled for 2026-10-12. | [P] for the versions; [S] https://expo.dev/changelog/sdk-58-beta and https://reactnative.dev/releases/overview |
| **Play Billing Library** | **PBL 8+** is required for new apps and updates since **Aug 31, 2026** (extension to Nov 1, 2026). The deprecation table puts PBL 8's end at **Aug 31, 2027**, so PBL 9 will be needed by then. PBL 9.1.0 is out (2026-06-18). | [V] https://developer.android.com/google/play/billing/deprecation-faq and https://developer.android.com/google/play/billing/release-notes |
| **RevenueCat** | `react-native-purchases@10.12.0` → `purchases-hybrid-common:19.6.0` → `purchases:10.24.1` → `com.android.billingclient:billing:8.3.0`, so the PBL 8 requirement is met. | [P] Maven Central POMs |
| **16 KB pages** | Required for apps targeting API 35+ on 64-bit devices. "**Starting February 1, 2027**, if your app updates don't support 16 KB … you won't be able to release these updates." | [V] https://developer.android.com/guide/practices/page-sizes |
| **Edge-to-edge** | At targetSdk 36 the opt-out is "deprecated and disabled". Expo SDK 54+ always runs edge-to-edge, and the SDK 57 template sets `edgeToEdgeEnabled=true`. | [V] https://developer.android.com/about/versions/16/behavior-changes-16; [P] template `gradle.properties`; [S] https://expo.dev/changelog/sdk-54 |
| **Predictive back** | Enabled by default at targetSdk 36. Expo writes `android:enableOnBackInvokedCallback="false"` unless `android.predictiveBackGestureEnabled: true`. | [V] Android 16 behavior changes; [P] `@expo/config-plugins@57.0.10` `PredictiveBackGesture.js` |
| **New personal Play account** | Needs a closed test with **≥12 testers opted in continuously for ≥14 days** before production access. This applies to personal accounts created after Nov 13, 2023. | [S] https://support.google.com/googleplay/android-developer/answer/14151465 |
| **Developer verification** | Enforcement started **Sep 30, 2026** in Brazil, Indonesia, Singapore and Thailand, for installs from participating stores on certified devices running Android 7+. Global expansion follows in **2027**. ADB installs are unaffected. | [V] https://developer.android.com/developer-verification and FAQ |
| **Meta Wearables DAT** | `com.meta.wearable:mwdat-*` **1.0.0** is on **Maven Central** (no GitHub token needed). The `mwdat-core` AAR declares **minSdk 29**. Public publishing is still not generally open. | [P] https://repo1.maven.org/maven2/com/meta/wearable/; [S] for status |

---

## Phase 0: Foundation (dev build, Supabase, PowerSync, auth, migration, tokens)

### 0.1 Windows and Android phone setup
1. **Node LTS.** eas-cli 24.12.0 requires Node `^20.18.3 || >=22` [P `npm view eas-cli engines`].
2. **JDK 17** (Expo suggests `choco install -y microsoft-openjdk17`) [S https://docs.expo.dev/get-started/set-up-your-environment/]. RN 0.86's Gradle plugin pins Java 17 [P `@react-native/gradle-plugin` `JdkConfiguratorUtils.kt`]. Set `JAVA_HOME` yourself; Expo's Windows steps don't mention it [S].
3. **Android Studio.** In SDK Manager, install **Android SDK Platform 36**, Build-Tools 36.0.0, Platform-Tools and the Emulator. Expo's page still says "Android 15 SDK", which is stale for SDK 57: compileSdk is 36 [P]. Gradle can fetch NDK 27.1.12297006 on the first native build [I].
4. **Environment variables.** Set `ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk` and add `%ANDROID_HOME%\platform-tools` to PATH. Open a new terminal, then check that `adb devices` lists the phone [S].
5. **Windows path limits.**
   - Keep the repo at a short path such as `C:\dev\dualrep`, not inside OneDrive.
   - Turn on "Enable Win32 long paths" (gpedit, or `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled=1`).
   - Run `git config --global core.longpaths true`.
   - CMake/Ninja under the New Architecture hit the 260-character MAX_PATH limit [S https://docs.swmansion.com/react-native-reanimated/docs/guides/building-on-windows, https://www.nutrient.io/guides/react-native/troubleshooting/windows-path-length-cmake-error/].
   - With pnpm, add `node-linker=hoisted` [S].
6. **Phone.** Turn on Developer options → USB debugging. If Metro isn't reachable, run `adb reverse tcp:8081 tcp:8081` [S].
7. **Two ways to build:**
   - **Cloud (no Android Studio needed):** `eas build -p android --profile development`, then install the APK.
   - **Local:** `npx expo run:android`. This needs steps 2–5.
   - Expo Go is not an option. PowerSync's native SQLite adapter needs a development build [I].

### 0.2 Pick the SDK
Start on **SDK 57**. It is the current stable release, targets 36 (meets Play today), and PowerSync and RevenueCat are tested against it. Upgrade to SDK 58 once it ships and your native libraries catch up. SDK 58 moves to **AGP 9.2.1 and Kotlin 2.2**, a bigger toolchain jump [P / I].

### 0.3 `app.config.ts` baseline
```ts
// app.config.ts (Expo SDK 57)
import type { ConfigContext, ExpoConfig } from 'expo/config';

type Variant = 'development' | 'preview' | 'production';
const VARIANT = (process.env.APP_VARIANT ?? 'production') as Variant;
const SUFFIX = VARIANT === 'production' ? '' : VARIANT === 'development' ? '.dev' : '.preview';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: VARIANT === 'production' ? 'DualRep' : `DualRep (${VARIANT})`,
  slug: 'dualrep',
  scheme: VARIANT === 'production' ? 'dualrep' : `dualrep-${VARIANT}`, // Supabase auth redirect: dualrep://auth-callback
  version: '0.1.0',
  orientation: 'portrait',            // NOTE: ignored on >=600dp displays when targetSdk=36
  userInterfaceStyle: 'automatic',
  android: {
    package: `com.interverse.dualrep${SUFFIX}`,   // dev/preview/prod install side by side
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      monochromeImage: './assets/adaptive-icon-mono.png',
      backgroundColor: '#0B0B0F',
    },
    allowBackup: false,                 // keep auth tokens out of Android cloud backup
    predictiveBackGestureEnabled: false, // Expo writes enableOnBackInvokedCallback="false" (opt-out)
    blockedPermissions: [
      // The Expo template ships these "optional" permissions; DualRep doesn't need them.
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      ...(VARIANT === 'development' ? [] : ['android.permission.SYSTEM_ALERT_WINDOW']),
    ],
  },
  plugins: [
    // Leave SDK levels at Expo defaults (compile/target 36, min 24). Later phases bump minSdk.
    ['expo-build-properties', { android: {} }],
    ['expo-navigation-bar', { enforceContrast: true }],
  ],
  extra: { eas: { projectId: '<EAS project id>' } },
});
```
- **Template permissions [P].** The SDK 57 template manifest declares `SYSTEM_ALERT_WINDOW`, `VIBRATE` and `READ/WRITE_EXTERNAL_STORAGE` (maxSdk 32). `android.permissions` only adds permissions; it never removes them. Use `blockedPermissions`, which writes `tools:node="remove"`.
- **Cleartext HTTP [P].** The template's `debug` and `debugOptimized` manifests set `usesCleartextTraffic="true"`. Dev-client builds can therefore reach a local `supabase start` over `http://<LAN-IP>`, but **preview and production (release) builds cannot**. Point preview builds at the hosted Supabase project over HTTPS.

### 0.4 `eas.json`
The field names below are checked against the `@expo/eas-json@24.9.0` schema [P]. Values are proposals.
```json
{
  "cli": { "version": ">= 24.0.0", "appVersionSource": "remote" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "env": { "APP_VARIANT": "development" },
      "android": { "buildType": "apk" }
    },
    "preview": {
      "distribution": "internal",
      "env": { "APP_VARIANT": "preview" },
      "android": { "buildType": "apk" }
    },
    "production": {
      "env": { "APP_VARIANT": "production" },
      "autoIncrement": true,
      "android": { "buildType": "app-bundle" }
    }
  },
  "submit": {
    "production": {
      "android": {
        "serviceAccountKeyPath": "./secrets/play-service-account.json",
        "track": "internal",
        "releaseStatus": "draft"
      }
    }
  }
}
```
- **Remote versioning.** `appVersionSource: "remote"` plus `autoIncrement` stores `versionCode` on EAS servers [S https://docs.expo.dev/build-reference/app-versions/].
- **Allowed values [P].** `releaseStatus` accepts `completed | draft | halted | inProgress`; `track` defaults to `internal`.
- **Why `draft`.** An app that has never been published only accepts draft releases [S, forum report].

### 0.5 Play Console and identity work (start now; these have long lead times)
1. **Choose the account type.**
   - If Interverse is a legal entity, open an **organization** account. It needs a **D-U-N-S number**, which is free but "can take up to 28 days" [V https://developer.android.com/developer-verification/guides/faq; S https://support.google.com/googleplay/android-developer/answer/13634885].
   - Organization accounts appear to skip the 12-tester / 14-day gate. Google's text scopes the gate to *personal* accounts; the "org accounts are exempt" wording is from third-party sources [S].
2. **Complete Play Console identity verification.**
   - Play-distributed apps that use Play App Signing are then **registered automatically** for Android developer verification [V https://developer.android.com/blog/posts/android-developer-verification-rolling-out-to-all-developers-on-play-console-and-android-developer-console and FAQ].
   - Play Console's verification page shows registration status for each app [V].
3. **Create the app** for `com.interverse.dualrep` to reserve the package name.
4. **Developer-verification impact on beta APKs:**
   - **Today:** enforcement covers only the participating stores in the four launch countries. Sideloaded APKs (EAS internal-distribution links) still install. "Unregistered apps can be sideloaded with ADB or advanced flow" [V].
   - **2027:** verification "will be expanded globally for all apps on certified Android devices" [V]. An unregistered sideloaded APK (for example `com.interverse.dualrep.dev` signed with the EAS keystore) would then need ADB or the "advanced flow", which means a Developer-options toggle plus a 24-hour wait [S].
   - **Mitigation [I]:** put testers on **Play internal/closed tracks** rather than APK links. If you keep APK variants, register those package names and signing certificates through Play Console's "apps distributed outside Play" flow. Signing keys can't be recovered for registration, so back up any key you manage yourself [V FAQ].

### 0.6 Schema and auth decisions driven by Play rules
- **Account deletion is mandatory before launch** (in-app path plus a web link) [S https://support.google.com/googleplay/android-developer/answer/13327111]. Make every user-owned table `user_id uuid references auth.users on delete cascade`, and keep Storage paths prefixed by user id. Deletion then becomes a single admin call in an Edge Function [I].
- **Google Sign-In / App Links (if used).** Register SHA-1/SHA-256 fingerprints for three keys: the debug keystore, the EAS upload key, and the **Play app-signing key**. Find them under Play Console **Release → Setup → App signing** [V https://developer.android.com/studio/publish/app-signing].
- **Keys.** No AI or service keys in the APK, because APKs can be decompiled. Tracy is reached only through Supabase Edge Functions, as already planned.

### 0.7 Design tokens: edge-to-edge, back, large screens
- **Insets.** Build tokens and layouts on safe-area insets for both gesture navigation and 3-button navigation. Status and navigation bars are transparent and cannot be opted out at target 36 [V].
- **Large screens.** At target 36 on screens ≥600dp, `screenOrientation`/`orientation` and aspect-ratio locks are ignored. Make study and training screens fluid for tablets and foldables. The temporary opt-out (`PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY`) disappears at API 37 [V Android 16/17 behavior pages].
- **Predictive back.** Leave it off for now: it is Expo's default, and react-native-screens compatibility was the reason Expo kept it opt-in [S SDK 54 changelog]. Revisit on each SDK upgrade.

### 0.8 Running the Phase 0 gate on an Android phone [I]
1. Install the dev build and sign in. Let PowerSync finish its initial sync.
2. Turn on airplane mode. Create a row and confirm it renders from local SQLite.
3. **Test the hard case:** swipe the app away (don't use Force stop), reopen it while still offline, and confirm the row is still queued.
4. Turn airplane mode off with the app in the foreground. Confirm the row appears in Postgres (Supabase table editor) and that RLS let it through. Confirm the upload queue is empty.
5. Repeat once with a **preview (release) APK** against hosted Supabase. This proves release networking works: no cleartext, and the correct scheme/redirects.

Do **not** add a `dataSync` foreground service for sync. It is capped at 6 hours per 24 hours on Android 15+ and needs a Play declaration [V https://developer.android.com/develop/background-work/services/fgs/timeout].

### 0.9 16 KB baseline (catch PowerSync/SQLite native libraries early)
- **What RN covers [P].** RN's Gradle plugin adds `-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON` to app CMake. RN 0.77+ supports 16 KB [S https://reactnative.dev/blog/2025/01/21/version-0.77]. Third-party native libraries still need checking.
- **Check every preview or production artifact [V page-sizes]:**
  - `"%ANDROID_HOME%\build-tools\36.0.0\zipalign.exe" -v -c -P 16 4 app.apk` should end with "Verification successful".
  - `bundletool dump config --bundle=app.aab | findstr alignment` should show `PAGE_ALIGNMENT_16K`.
  - Android Studio APK Analyzer → `lib/` **Alignment** column.
  - Test on the "16 KB Page Size" emulator image; `adb shell getconf PAGE_SIZE` should return `16384`.

---

## Phase 1: Core loop (study block ↔ training block, focus timer)

### 1.1 Recommended timer design: simplest compliant option, no foreground service
1. **Keep time from the clock, not a ticking process.** Persist `endsAt` (epoch ms) locally and render `remaining = endsAt - Date.now()`. Recompute on `AppState` → `active`. Nothing has to run while the screen is off.
2. **Alert with a scheduled local notification** at `endsAt`, using `expo-notifications` with a `DATE` trigger on a high-importance `timers` channel with sound and vibration. Cancel or reschedule on pause or skip.
   - How exact is it? [P `ExpoSchedulingDelegate.kt`] expo-notifications calls `setExactAndAllowWhileIdle` **only if `canScheduleExactAlarms()`**. Otherwise it falls back to inexact `setAndAllowWhileIdle`, which Doze can defer. Measure the real delay on the founder's phone with the screen off for 25+ minutes [I].
3. **Optional, for precise alerts: `SCHEDULE_EXACT_ALARM`.** This is user-granted special access and is denied by default on fresh installs that target 13+ (Android 14+) [V https://developer.android.com/about/versions/14/changes/schedule-exact-alarms].
   - Show an in-app explainer, then open `IntentLauncher.ActivityAction.REQUEST_SCHEDULE_EXACT_ALARM` [P, expo-intent-launcher 57 includes the constant] with `data: 'package:com.interverse.dualrep'`.
   - Check `canScheduleExactAlarms()`. expo-notifications doesn't appear to expose it, so this needs a tiny native module [I].
   - When the user revokes the permission, the system cancels your exact alarms [V].
4. **Don't declare `USE_EXACT_ALARM`.**
   - Android's docs reserve it for "calendar or alarm clock apps", and "apps will not be able to publish a version … with this permission … unless they qualify" [V https://developer.android.com/develop/background-work/services/alarms/schedule].
   - Play's policy page (https://support.google.com/googleplay/android-developer/answer/12253906) could not be opened. My recollection is that it lists "alarm or timer app" and "calendar app" [I]. DualRep is a study and fitness app with timed blocks, so a reviewer may reject it.
   - **Eligibility is uncertain.** SCHEDULE_EXACT_ALARM is the lower-risk path. I believe it needs no Play declaration [I, verify in Play Console].
5. **Play the end sound through the notification channel, not app audio.**
   - On **Android 17 (all apps, whatever their target)**, background audio requires a visible activity or a non-`shortService` foreground service; otherwise "Playback is silenced" [V https://developer.android.com/about/versions/17/changes/bg-audio].
   - A notification sound is played by the system, so it is unaffected [I].
6. **Live countdown in the notification shade (optional).**
   - Post an ongoing notification with `setUsesChronometer(true)` + `setChronometerCountDown(true)` + `setWhen(endsAt)`. It ticks with no app code running [I].
   - expo-notifications exposes `sticky` (ongoing) but **no chronometer** [P], so this needs a small local Expo module.
   - On Android 16+ you can request promotion as a **Live Update** (`POST_PROMOTED_NOTIFICATIONS`, `setRequestPromotedOngoing`, must be ongoing). Google lists "starting a workout" as an appropriate user-initiated example [V https://developer.android.com/develop/ui/views/notifications/live-update].
   - Since Android 14, users can dismiss ongoing notifications except while the device is locked [V https://developer.android.com/about/versions/14/behavior-changes-all]. Treat this display as a convenience only.
7. **Don't use `USE_FULL_SCREEN_INTENT`** for block-end alerts. Play restricts it (see the full-screen-intent section of https://support.google.com/googleplay/android-developer/answer/13392821) [S/I].

**Verdict:** a scheduled local notification plus clock-derived UI, with SCHEDULE_EXACT_ALARM optional. No foreground service, so no Play foreground-service declaration and no video.

### 1.2 If you ever need a foreground service for the timer (avoid)
- **`shortService`** is capped at about 3 minutes, so it can't cover a block [V https://developer.android.com/develop/background-work/services/fgs/service-types].
- **`health`** requires body-sensor or `ACTIVITY_RECOGNITION` grants [V].
- **`systemExempted`** is "reserved for system applications…". Holding an exact-alarm permission makes it technically allowed, but don't use it [V].
- **What's left is `specialUse`:**
```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE"/>
<service android:name=".FocusTimerService" android:exported="false" android:foregroundServiceType="specialUse">
  <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
            android:value="User-started focus/rest countdown that must alert exactly at block end and show live remaining time"/>
</service>
```
- The subtype text is reviewed at submission [V].
- **Play declaration [S https://support.google.com/googleplay/android-developer/answer/13392821]:** under App content, provide a description, the user impact if the task is deferred, **a video link for each foreground-service type**, and a use case picked from a list. Reviewers reject when "the declared use case(s) can be interrupted or deferred … without creating a negative user experience" [S].
- Google previewed foreground-service policy changes in April 2026 (geofencing removed as an approved use) [S https://support.google.com/googleplay/android-developer/answer/16926792].

### 1.3 Notifications: POST_NOTIFICATIONS, channels, expo-notifications
- **Runtime permission.** `POST_NOTIFICATIONS` is a runtime permission on Android 13+. At target ≥33 **you decide when to prompt** [V https://developer.android.com/develop/ui/views/notifications/notification-permission]. Ask in context, for example when the user starts their first block. If the user denies it, you can't post notifications. Foreground-service notices still appear in Task Manager. Media-session notifications are exempt [V].
- **What expo-notifications adds [P].** Its library manifest already merges `POST_NOTIFICATIONS` and `RECEIVE_BOOT_COMPLETED` (it reschedules after reboot). It is auto-applied by prebuild even if it isn't listed under plugins [P `@expo/prebuild-config` `versionedExpoSDKPackages`]. List it anyway so you can configure it:
```ts
plugins: [
  ['expo-notifications', {
    icon: './assets/notification-icon.png',  // white silhouette on transparent
    color: '#5B8CFF',
    defaultChannel: 'timers',
    sounds: ['./assets/sounds/block_end.wav'],
  }],
],
android: { permissions: ['android.permission.SCHEDULE_EXACT_ALARM'] }, // only if you adopt 1.1 step 3
```
- **Channels.** Create them at startup with versioned IDs, because users own the channel settings once a channel exists [I]:
```ts
await Notifications.setNotificationChannelAsync('timers', {
  name: 'Block timers', importance: Notifications.AndroidImportance.HIGH,
  sound: 'block_end.wav', vibrationPattern: [0, 300, 200, 300], enableVibrate: true,
  lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
});
// also: 'reviews' (FSRS due, DEFAULT), 'coach' (Tracy, DEFAULT), 'social' (Phase 4, DEFAULT/LOW)
await Notifications.scheduleNotificationAsync({
  content: { title: 'Block done', body: 'Switch to your set', sound: 'block_end.wav' },
  trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: endsAt, channelId: 'timers' },
});
```
  The enum names, `DateTriggerInput.channelId` and the channel fields are all checked against expo-notifications 57.0.22 [P].
- Keep the screen on during sets with `expo-keep-awake`, bundled with SDK 57 [P].

### 1.4 Distribution while building
Put the founder and testers on the **Play internal testing track** (fast, no review gate [I]) instead of APK links. This avoids the 2027 sideload issue in 0.5.

---

## Phase 2: Study engine (quiz-first FSRS) and audio study mode

### 2.1 Foreground-service types for audio study mode [V service-types]
| Need | Type | Manifest permission | Runtime prerequisite |
|---|---|---|---|
| TTS playback, lock-screen/headset controls | `mediaPlayback` | `FOREGROUND_SERVICE_MEDIA_PLAYBACK` | none |
| Speech recognition from mic with screen off | `microphone` | `FOREGROUND_SERVICE_MICROPHONE` | **`RECORD_AUDIO` granted**; subject to while-in-use rules |
| Both | one service with `mediaPlayback\|microphone`, or two services | both + `FOREGROUND_SERVICE` | as above |

**Rules that shape the design [V https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start]:**
- Starting any foreground service from the background is blocked on Android 12+ unless an exemption applies.
- A **microphone** service **can't be created while the app is in the background**. Doing so "throws a SecurityException".
- Start both services when the user taps "Start audio study" in the foreground, and keep the microphone service alive for the whole session. Don't try to restart it from a headset press with the screen off; I couldn't confirm a media-button exemption for the microphone while-in-use rule [V/I].
- Apps targeting 15+ can't launch `mediaPlayback` or `dataSync` from `BOOT_COMPLETED`, which doesn't matter for DualRep [V].

### 2.2 Implementation path in Expo
- **expo-audio 57.0.5 [P]:**
  - `enableBackgroundPlayback` (**default `true`**) adds `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK` and a media3 `MediaSessionService` (`expo.modules.audio.service.AudioControlsService`, type `mediaPlayback`).
  - `enableBackgroundRecording` adds `FOREGROUND_SERVICE_MICROPHONE` + `POST_NOTIFICATIONS` and `AudioRecordingService` (type `microphone`).
  - `recordAudioAndroid` defaults to `true` (adds `RECORD_AUDIO`).
  - The plugin only runs when listed; it isn't auto-applied [P]. **If expo-audio is added earlier, for example for UI sounds, pass `{ enableBackgroundPlayback: false, recordAudioAndroid: false }`.** Otherwise the build ships a media foreground service and RECORD_AUDIO, which forces a Play foreground-service declaration and Data safety audio questions.
  - Phase 2 entry:
```ts
['expo-audio', { enableBackgroundPlayback: true, enableBackgroundRecording: true, recordAudioAndroid: true }]
```
  - Resulting merged manifest:
```xml
<uses-permission android:name="android.permission.RECORD_AUDIO"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE"/>
<service android:name="expo.modules.audio.service.AudioControlsService" android:exported="false"
         android:foregroundServiceType="mediaPlayback">
  <intent-filter><action android:name="androidx.media3.session.MediaSessionService"/></intent-filter>
</service>
<service android:name="expo.modules.audio.service.AudioRecordingService" android:exported="false"
         android:foregroundServiceType="microphone"/>
```
- **Headset buttons.** expo-audio's media session keeps play/pause and seek but explicitly **removes next/previous commands** [P `AudioMediaSessionCallback.kt`]. Its docs also say playback stops after about 3 minutes in the background unless `setActiveForLockScreen` is used [P]. If you want headset mappings like "next = got it / previous = again", write a **local Expo module** around media3 `MediaSessionService` with custom commands [I].
- **TTS options:**
  - Server-side TTS through Tracy, played as audio items in that media session. This is the most robust under the Android 17 rules [I].
  - `expo-speech` (Android `TextToSpeech`). Whether system TTS output from a backgrounded app is caught by Android 17 audio hardening is **unverified**; prototype it with a `mediaPlayback` service running.
- **Speech recognition options:**
  - `expo-speech-recognition@57.1.0` (jamsch). Its plugin adds `RECORD_AUDIO` and a `<queries>` entry for `com.google.android.googlequicksearchbox`, but **no foreground service** [P]. It wraps Android `SpeechRecognizer`; continuous mode needs Android 13+ [P README]. **Screen-off behavior is unverified, so plan a spike.**
  - Fallback: record with expo-audio inside the microphone service and send clips to Tracy for speech-to-text.

### 2.3 Android 17 background-audio hardening (plan now; it bites at the next target bump)
- **All apps on Android 17:** background audio interactions need a visible activity or a foreground service that is not `shortService` [V bg-audio].
- **Apps targeting 37:** a backgrounded app must be running a foreground service **with while-in-use capability**. Start the `mediaPlayback` service while in the foreground. Google recommends media3 `MediaSessionService` [V].
- **Test it:** `adb shell cmd audio set-enable-hardening enable|throw` [V].

### 2.4 FSRS reminders and sync
- Daily "reviews due" reminders: an inexact `DAILY` trigger on the `reviews` channel is enough. No exact alarm is needed.
- Periodic background sync, if wanted: `expo-background-task` (bundled ~57.0.21 [P]; WorkManager, roughly 15-minute minimum [I]). No `dataSync` foreground service.

### 2.5 Play declarations triggered in this phase
- **Foreground-service declaration** for `mediaPlayback` and `microphone`, with one demonstration video per type. Show: start audio study in the foreground → lock screen → TTS continues → answer by voice / headset [S 13392821].
- **Data safety:** "Audio files → Voice or sound recordings" if any audio leaves the device. On-device-only recognition is a judgment call; see 5.5.

---

## Phase 3: Tracy coaching

### 3.1 AI-generated content policy
Apps that generate content with AI must provide **in-app reporting or flagging of AI output without leaving the app**, and use those reports for moderation [S https://support.google.com/googleplay/android-developer/answer/13985936]. Add "Report this response" on Tracy messages and store reports through an Edge Function.

### 3.2 Health claims (ADHD) and the disclaimer
- **What Play's Health Content and Services policy requires [S https://support.google.com/googleplay/android-developer/answer/16679511, /16555673]:**
  - **Non-regulated apps must include a store-description disclaimer** that the app is "**not a medical device and does not diagnose, treat, cure, or prevent any medical condition**", and remind users to consult a healthcare professional.
  - Misleading health functionality or claims are prohibited whether or not a disclaimer is present.
  - Regulated medical devices must declare that status.
  - This text is from a policy-preview excerpt with an effective date of Jan 28, 2026. Confirm the exact wording in Play Console.
- **Wording rules for DualRep [I]:**
  - Never "treats/manages/reduces ADHD symptoms", "ADHD therapy", "clinically proven", or "alternative to medication".
  - Describe mechanics instead: "short focus blocks", "quiz-first study", "movement breaks between blocks".
  - If ADHD is mentioned at all, frame it as a design inspiration or audience, never as an outcome.
  - Put the same disclaimer in onboarding, About, and Tracy's coach screen.
  - Add an exercise-safety line ("check with a doctor before starting a new exercise program").
  - Tracy's system prompt must refuse diagnosis and medication advice and redirect to professionals.

### 3.3 Health apps declaration (App content)
- **Categories offered** (Figure 1 on the Health Connect page) include "Activity and fitness", "Stress management, relaxation, mental acuity" and "Mental and behavioral health" [V https://developer.android.com/health-and-fitness/guides/health-connect/publish/declare-access].
- **Recommendation [I]:** declare **Activity and fitness**, and possibly "Stress management, relaxation, mental acuity". Avoid the medical categories ("Mental and behavioral health", "Diseases and conditions management") unless you deliberately take on the stricter regime.
- The privacy policy must sit at a public, non-geofenced URL and must not be a PDF [S].

### 3.4 Health Connect (optional: write workouts)
- **Data type.** Write `ExerciseSessionRecord` with `EXERCISE_TYPE_STRENGTH_TRAINING` or `EXERCISE_TYPE_WEIGHTLIFTING`.
- **Permissions.** `android.permission.health.WRITE_EXERCISE`; add `READ_EXERCISE` only if you read back. Others exist: `READ_HEART_RATE`, `READ_HEALTH_DATA_HISTORY` for data older than 30 days, and `READ_HEALTH_DATA_IN_BACKGROUND` [V https://developer.android.com/health-and-fitness/guides/health-connect/plan/data-types].
- **Platform requirements [V get-started].**
  - The SDK needs **API 26+**; the Health Connect app needs Android 9+.
  - It is built into the framework on Android 14+.
  - The manifest needs `<queries><package android:name="com.google.android.apps.healthdata"/></queries>` and a privacy-policy rationale activity: `androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE`, plus an Android 14+ `activity-alias` with `VIEW_PERMISSION_USAGE` / `HEALTH_PERMISSIONS`.
  - Declared data types in Play Console must match the manifest.
- **Expo:** `react-native-health-connect@4.1.3` (connect-client 1.1.0) ships an Expo plugin that adds the rationale intent-filter and the alias [P]. Its README says the old Google Form is retired on Sep 3, 2026 and approval can take up to 7 days [P README].
```ts
android: { permissions: ['android.permission.health.WRITE_EXERCISE'] },
plugins: [
  ['expo-build-properties', { android: { minSdkVersion: 26 } }],
  'react-native-health-connect',
],
```
- No `health` foreground service is needed for writing completed sessions.

---

## Phase 4: Friends
- **User-generated content policy [S https://support.google.com/googleplay/android-developer/answer/12923286]:**
  - In-app **report content**, **report user** and **block user** as separate, clearly labelled controls.
  - Terms or community guidelines the user accepts before posting.
  - Timely moderation.
  - Rejections have specifically cited a missing "report user" control [S].
- **Push notifications** for friend activity: FCM through `android.googleServicesFile` plus FCM v1 credentials in EAS. Use a `social` channel at DEFAULT/LOW importance [I].
- **Data safety additions:** Personal info → Name/User IDs (profiles); App activity → Other user-generated content; Messages → Other messages if you add DMs; Photos if avatars or progress photos are shared.
- **Build the deletion flow now** (see 5.6) so it can be verified before launch.

---

## Phase 5: Android launch

### 5.1 Production-access gate
- **Personal account:** run a closed test with **≥12 opted-in testers for 14 consecutive days**. The count must not drop below 12, so recruit 15–20. Then apply from the Dashboard [S 14151465 + third-party]. Start the closed test **at least 3 weeks before** the target launch date.
- **Organization account:** gate believed not to apply [S].

### 5.2 Signing and EAS Submit
- **Play App Signing is required for new apps.** You sign with an upload key and Google re-signs. A lost upload key can be reset [V https://developer.android.com/studio/publish/app-signing]. EAS manages the upload keystore.
- **Service account:**
  - Create it in Google Cloud and enable the **Google Play Android Developer API**.
  - In Play Console **Users and permissions**, invite the service-account email with release permissions for this app [S https://developers.google.com/android-publisher/getting_started].
  - Store the JSON key in EAS or a gitignored path.
- **First upload:** `eas build -p android --profile production`, then `eas submit -p android --profile production`.
  - Expo's docs conflict on whether the **first upload must be manual**: the Play API historically required it [S https://docs.expo.dev/submit/android/], while the newer manual-submission page says EAS can create it [S]. If the API rejects it, upload the first AAB by hand to Internal testing.
  - Keep `releaseStatus: "draft"` until the app has been published once.

### 5.3 Billing (subscriptions through RevenueCat)
- **Now:** PBL 8 is required. `react-native-purchases@10.12.0` uses PBL **8.3.0** [P]. RevenueCat's v9.0.0 was the PBL 8 migration release [S https://www.revenuecat.com/blog/engineering/google-play-billing-v8].
- **Next:** PBL 9 is needed by **Aug 31, 2027** (inferred from the deprecation table) [V/I]. Track RevenueCat releases. As of today their Android SDK is still on 8.3.0 [P].
- **Testing:** the Expo Go mock mode doesn't make real purchases. Test on a dev build with license testers [S].
- **RevenueCat ↔ Play setup** (service account with financial permissions, real-time developer notifications) is RevenueCat-specific and **not verified here**.

### 5.4 App content declarations to complete
| Declaration | Notes |
|---|---|
| Privacy policy | Public URL |
| App access | Reviewer test credentials |
| Ads | — |
| Content rating | — |
| Target audience | — |
| Data safety | See 5.5 |
| Account deletion URL | See 5.6 |
| Health apps | See 3.3 |
| Foreground-service types + videos | Only if Phase 2 audio mode ships |
| Exact alarm | Only if `USE_EXACT_ALARM` is declared; not recommended |
| Health Connect data types | Only if 3.4 ships |
| Store listing | Medical disclaimer in the description |

Inspect the **merged manifest** of the production build. Every permission there will drive a declaration.

### 5.5 Data safety draft for DualRep
Category names are from Google's guide [V https://developer.android.com/privacy-and-security/declare-data-use]. Definitions of "collected" and "shared" and the service-provider exemption are in https://support.google.com/googleplay/android-developer/answer/10787469 [not fetched].

| Category → type | DualRep source | Likely answer [I] |
|---|---|---|
| Personal info → Email address, User IDs (Name if collected) | Supabase Auth, profiles | Collected; account management, app functionality |
| Health and fitness → **Fitness info** | Workouts, sets, reps, loads, Health Connect writes | Collected; app functionality, personalization |
| Health and fitness → Health info | Only if you store symptoms, diagnoses, medication or mood | Avoid collecting; declare if you do |
| Photos and videos → Photos | Progress photos, card images, avatars | Collected if uploaded |
| Files and docs | Uploaded study material (PDFs, notes) | Collected if uploaded |
| Audio files → Voice or sound recordings | Clips sent to Tracy for speech-to-text | Collected if audio leaves the device |
| App activity → App interactions, Other user-generated content (In-app search history if logged) | Study and training events, cards, Tracy chats, friend posts | Collected |
| Financial info → Purchase history | RevenueCat / Play subscriptions | Likely collected |
| App info and performance → Crash logs, Diagnostics | Sentry or similar, if added | Collected |
| Device or other IDs | FCM token, RevenueCat app user ID | Likely collected |
| Security practices | Encrypted in transit; deletion available | Yes / Yes |

If Tracy forwards user content to a third-party LLM, decide with counsel whether that counts as "shared" or falls under the service-provider exemption.

### 5.6 Account deletion (required)
- **What Google requires [S 13327111]:**
  - An **in-app path** (a link to the web resource is acceptable).
  - A **web URL** where users can request deletion **without reinstalling the app**, entered in the Data safety form.
  - Deletion must remove associated data. Deactivating or "freezing" an account does not count. Retained data must be justified, for example security or legal reasons.
- **Implementation [I]:** an Edge Function `delete-account` (service role) that deletes the `auth.users` row so the cascades run, removes Storage objects and deletes the RevenueCat subscriber, plus a client step that clears the local PowerSync database.

### 5.7 Pre-submit technical checks
- [ ] targetSdk 36 (Expo 57 default) [P]
- [ ] 16 KB checks from 0.9 pass on the production AAB, and Play Console's App bundle explorer shows no memory-page-size warning [V]
- [ ] Merged manifest contains only the permissions you intend to declare (see the ledger below)
- [ ] Edge-to-edge screens checked with gesture and 3-button navigation, on a ≥600dp emulator, and in dark mode
- [ ] Test notifications on Android 13+ with POST_NOTIFICATIONS denied (the app must degrade gracefully)
- [ ] Test on an **Android 17** device or emulator for background audio (Phase 2 features)

### 5.8 Upcoming deadlines (2027) [I unless noted]
| Date | Deadline |
|---|---|
| **Feb 1, 2027** | 16 KB support required to release updates [V] |
| **Aug 31, 2027** | PBL 9 required (inferred from the PBL 8 deprecation date) [V/I] |
| **~Aug 31, 2027** | Target API **37** likely, not announced |

Targeting 37 brings:
- WIU-only background audio [V]
- No large-screen orientation opt-out [V]
- `ACCESS_LOCAL_NETWORK` runtime permission [V] (check its effect on dev builds talking to Metro or a LAN Supabase [I])
- Read-only native libraries for `System.load()` [V]

Source: https://developer.android.com/about/versions/17/behavior-changes-17

---

## Phase 6: iOS (Android-side notes only)
- Keep platform branches thin: Health Connect vs HealthKit (`@kingstinct/react-native-healthkit@16.1.0` [P]) behind one interface. Do the same for notification exactness (iOS has no exact-alarm concept) and audio sessions.
- The medical-disclaimer and no-diagnosis wording applies on iOS too. One developer reported an App Store 1.4.1 rejection despite disclaimers [S, anecdotal].
- Keep `APP_VARIANT`-based identifiers aligned across platforms (bundle ID vs package).

---

## Phase 7: Glasses (Meta Wearables Device Access Toolkit)

**Status and distribution:**
- **Distribution [P].** Artifacts are published to **Maven Central** under `com.meta.wearable`: `mwdat-core`, `-camera`, `-display`, `-inputs`, `-motion`, `-speech`, `-mockdevice`. Versions run 0.7.0 → **1.0.0**, last updated 2026-09-24 [P maven-metadata]. No GitHub Packages PAT is needed for these versions. Older 0.x docs described GitHub Packages with a `read:packages` token [S].
- **Status [S].** Meta announced DAT **1.0** around Meta Connect (rollout from Sep 30, 2026) [S https://developers.meta.com/blog/meta-connect-recap/]. However, the **path for publishing to the general public is "coming soon"**. The preview-era rule was that participants may share builds with their own testers while "only select partners" publish publicly [S https://github.com/facebook/meta-wearables-dat-android, https://developers.meta.com/wearables/faq/]. Treat public release of glasses features as **not yet permitted** unless Meta approves DualRep.

**Android requirements, from the `mwdat-core-1.0.0.aar` manifest [P]:**
- `minSdkVersion 29` (Android 10).
- `BLUETOOTH_CONNECT` (runtime on Android 12+) and `BLUETOOTH`.
- `<queries>` for `com.facebook.stella` (Meta AI app).
- An exported `ACDCRegistrationService`.
- Kotlin metadata **2.2.0** and `kotlinx-coroutines-android:1.11.0` [P]. RN 0.86's Kotlin 2.1.20 should read 2.2 metadata (one-version forward compatibility) [I]. If compilation fails, set `expo-build-properties` → `android.kotlinVersion` to 2.2.x, or move to SDK 58 (Kotlin 2.2.0) [P/I].
- All arm64 `.so` files in `mwdat-core` 1.0.0 are **16 KB aligned** (LOAD p_align = 16384) [P, checked with an ELF script].

**App manifest and registration:**
- Add `<meta-data android:name="com.meta.wearable.mwdat.APPLICATION_ID" android:value="0"/>` for Developer Mode, or use the Wearables Developer Center app ID [S].
- Registration and permission grants run through the Meta AI app [S https://wearables.developer.meta.com/docs/develop/dat/permissions-requests/].
- Developer Mode is enabled in the Meta AI app by tapping its version number 5 times [S].

**Mock Device Kit:** `mwdat-mockdevice` simulates pairing, device state, permissions and camera streaming without hardware. It **doesn't support display glasses** [S https://wearables.developer.meta.com/docs/testing-mdk-android/]. Use it as `debugImplementation` and in CI.

**Expo plan [I]:**
- Write a **local Expo module** (`npx create-expo-module --local`, Kotlin) that wraps DAT.
- Its config plugin should:
  - add the Maven dependency;
  - set `minSdkVersion: 29` via expo-build-properties (this drops Android 7–9 users);
  - add `BLUETOOTH_CONNECT` and the meta-data.
- Gate the module behind `APP_VARIANT=glasses`, or a build-time flag, so **production Play builds don't include DAT until Meta opens publishing**.
- Community wrappers exist, unaudited: `@chrisgocode/expo-meta-wearables-dat@2.2.0` (2026-10-03) and `expo-meta-wearables-dat@1.3.0` [P npm].

---

## Permission ledger (what ends up in the merged manifest, and why)
| Permission | Added by | Phase | Runtime prompt | Play declaration |
|---|---|---|---|---|
| INTERNET | template | 0 | no | no |
| VIBRATE | template | 1 | no | no |
| SYSTEM_ALERT_WINDOW, READ/WRITE_EXTERNAL_STORAGE | template | — | — | **block** via `blockedPermissions` |
| POST_NOTIFICATIONS, RECEIVE_BOOT_COMPLETED | expo-notifications | 1 | POST_NOTIFICATIONS yes (13+) | no |
| SCHEDULE_EXACT_ALARM (optional) | `android.permissions` | 1 | special-access settings screen | believed none [I] |
| USE_EXACT_ALARM | — | — | — | **don't declare** |
| RECORD_AUDIO | expo-audio / expo-speech-recognition | 2 | yes | Data safety (audio) |
| FOREGROUND_SERVICE + _MEDIA_PLAYBACK | expo-audio (**default on**) | 2 | no | **FGS declaration + video** |
| FOREGROUND_SERVICE_MICROPHONE | expo-audio `enableBackgroundRecording` | 2 | no (needs RECORD_AUDIO) | **FGS declaration + video** |
| health.WRITE_EXERCISE (+READ_*) | `android.permissions` | 3 | Health Connect UI | Health apps form + data types |
| BLUETOOTH_CONNECT, BLUETOOTH | mwdat-core | 7 | BLUETOOTH_CONNECT yes (12+) | Data safety as applicable |
| com.android.vending.BILLING | Play Billing library | 5 | no | no [I] |

---

## Could not verify / open questions
1. **USE_EXACT_ALARM eligibility for a study/fitness timer.** The Play policy page could not be opened. Recommendation: don't declare it; use SCHEDULE_EXACT_ALARM or inexact delivery. Also unconfirmed: whether SCHEDULE_EXACT_ALARM needs any Play declaration.
2. **Real alert latency of inexact `setAndAllowWhileIdle`** with the screen off and Doze active on the founder's phone. Measure in Phase 1.
3. **Screen-off speech recognition and system TTS in background** (Android 14–17). Needs a spike; there is a fallback via recording plus Tracy speech-to-text.
4. **Organization-account exemption** from the 12×14 testing gate, and whether EAS can create the very first Play release over the API. Docs conflict.
5. **Health/medical disclaimer wording and effective date.** Taken from a policy-preview excerpt; confirm in Play Console.
6. **Next target-API deadline (API 37) and PBL 9 date.** Inferred from yearly patterns and the deprecation table, not announced.
7. **Developer verification** for non-Play APK variants in 2027: exact registration steps for dev/preview package names and EAS-managed keys.
8. **Meta DAT public-publishing status after 1.0.** Also the CLIENT_TOKEN meta-data question; sources disagree.
9. **RevenueCat ↔ Play** service-account permissions and real-time developer notifications were not researched (RevenueCat docs could not be opened).
10. **Windows `npx expo run:android` specifics on SDK 57** (exact SDK components). Inferred from the RN 0.86 version catalog, not from Expo's docs, which could not be opened.

### Key sources
- **developer.android.com:**
  - [target-sdk](https://developer.android.com/google/play/requirements/target-sdk)
  - FGS [types](https://developer.android.com/develop/background-work/services/fgs/service-types), [background-start](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start), [timeouts](https://developer.android.com/develop/background-work/services/fgs/timeout)
  - [exact alarms](https://developer.android.com/develop/background-work/services/alarms/schedule), [Android 14 exact alarms](https://developer.android.com/about/versions/14/changes/schedule-exact-alarms)
  - [notification permission](https://developer.android.com/develop/ui/views/notifications/notification-permission), [Live Updates](https://developer.android.com/develop/ui/views/notifications/live-update)
  - [Android 16 changes](https://developer.android.com/about/versions/16/behavior-changes-16), [Android 17 changes](https://developer.android.com/about/versions/17/behavior-changes-17), [Android 17 background audio](https://developer.android.com/about/versions/17/changes/bg-audio)
  - [predictive back](https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture), [16 KB](https://developer.android.com/guide/practices/page-sizes)
  - [Health Connect get-started](https://developer.android.com/health-and-fitness/guides/health-connect/develop/get-started), [data types](https://developer.android.com/health-and-fitness/guides/health-connect/plan/data-types), [declare access](https://developer.android.com/health-and-fitness/guides/health-connect/publish/declare-access)
  - [PBL deprecation](https://developer.android.com/google/play/billing/deprecation-faq), [PBL release notes](https://developer.android.com/google/play/billing/release-notes)
  - [Data safety types](https://developer.android.com/privacy-and-security/declare-data-use), [app signing](https://developer.android.com/studio/publish/app-signing)
  - [developer verification](https://developer.android.com/developer-verification), [verification FAQ](https://developer.android.com/developer-verification/guides/faq)
- **Play Help (search excerpts only):** [testing requirement](https://support.google.com/googleplay/android-developer/answer/14151465), [FGS requirements](https://support.google.com/googleplay/android-developer/answer/13392821), [account deletion](https://support.google.com/googleplay/android-developer/answer/13327111), [AI-generated content](https://support.google.com/googleplay/android-developer/answer/13985936), [UGC](https://support.google.com/googleplay/android-developer/answer/12923286), [health content](https://support.google.com/googleplay/android-developer/answer/16679511).
- **Expo (search excerpts only):** [SDK 57](https://expo.dev/changelog/sdk-57), [SDK 58 beta](https://expo.dev/changelog/sdk-58-beta), [eas.json](https://docs.expo.dev/build/eas-json/), [app versions](https://docs.expo.dev/build-reference/app-versions/), [Submit Android](https://docs.expo.dev/submit/android/), [environment setup](https://docs.expo.dev/get-started/set-up-your-environment/).
- **Artifacts inspected:** npm (`expo@57.0.27`, `react-native@0.86.3`, `react-native@0.88.0-rc.3`, `expo-template-bare-minimum@57.0.29`, `expo-modules-autolinking@57.0.14`, `@expo/config-plugins@57.0.10`, `@expo/config-types@57.0.2`, `@expo/prebuild-config@57.0.17`, `expo-notifications@57.0.22`, `expo-audio@57.0.5`, `expo-build-properties@57.0.22`, `expo-intent-launcher@57.0.1`, `expo-navigation-bar@57.0.3`, `expo-speech-recognition@57.1.0`, `react-native-health-connect@4.1.3`, `react-native-purchases@10.12.0`, `@expo/eas-json@24.9.0`) and Maven Central (`purchases-hybrid-common:19.6.0`, `purchases:10.24.1`, `com.meta.wearable:mwdat-core:1.0.0`).

## Open risks
- USE_EXACT_ALARM eligibility for a study/fitness timer is unconfirmed (Play policy page could not be opened); report recommends not declaring it and using SCHEDULE_EXACT_ALARM or inexact delivery, which may be delayed under Doze. Founder must measure real alert latency on device.
- Screen-off speech recognition (Android SpeechRecognizer via expo-speech-recognition) and system TTS in background under Android 14-17 rules are unverified; audio study mode needs a spike, fallback is recording + Tracy STT inside a microphone FGS started from foreground.
- expo-audio's config plugin defaults to enableBackgroundPlayback=true and recordAudioAndroid=true, silently adding a mediaPlayback FGS and RECORD_AUDIO that trigger Play FGS declaration/video and Data safety audio questions if the plugin is listed without overrides.
- Organization-account exemption from the 12-tester/14-day closed-testing gate is from third-party sources; Google's text only scopes the rule to personal accounts. D-U-N-S can take up to 28 days, so the account-type decision should be made in Phase 0.
- Android developer verification expands globally in 2027; sideloaded dev/preview APK variants (separate package names, EAS-managed keys) may become uninstallable without ADB/advanced flow unless registered. Exact registration steps for non-Play variants were not verified.
- Next deadlines are inferred, not announced: target API 37 likely ~Aug 31 2027 (brings Android 17 WIU background-audio rule, no large-screen opt-out, local network permission); PBL 9 needed by Aug 31 2027 and RevenueCat's current Android SDK still uses PBL 8.3.0.
- 16 KB page-size requirement blocks updates from Feb 1 2027; third-party native libs (PowerSync SQLite adapter, etc.) are compiled with their own CMake flags and must be verified with zipalign/bundletool on each release build.
- Medical-disclaimer wording and Health Content policy effective date come from a policy-preview search excerpt; must be confirmed in Play Console before writing the store listing.
- Meta DAT 1.0 is on Maven Central with minSdk 29 and Kotlin 2.2 metadata, but public publishing of glasses integrations appears not yet open; DAT must be kept out of production Play builds until Meta approves. Raising minSdk to 29 would drop Android 7-9 users.
- Expo SDK 58 (RN 0.88, AGP 9.2.1, Kotlin 2.2, compileSdk 37) is about to ship; starting on SDK 57 means a toolchain-heavy upgrade soon after Phase 0.
- Several primary sources (support.google.com, docs.expo.dev, expo.dev, revenuecat.com, meta.com) could not be opened during research; claims from them are search-excerpt quality and tagged [S] in the report.
