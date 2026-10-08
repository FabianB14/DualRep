# Android guide

Everything Android-specific about DualRep: the platform facts that shape the app, what the repo
already does, and a checklist for every phase of the [roadmap](ROADMAP.md).

- **Facts are as of 2026-10-08.** Google changes Play rules every year; re-check dates before relying
  on them.
- Items marked **verify** come from search excerpts or inference, not from a primary source that was
  read in full. The full research, with sources, is in [research/android.md](research/android.md).
- Setting up a Windows machine and a phone is in [SETUP.md](SETUP.md), not here.

---

## Why Android first

- **It is the founder's phone.** Every build gets tested on real hardware from day one, and the Phase 0
  gate is proven on it.
- **Cheaper to ship.** A Google Play developer account is a one-time fee (**verify** the current
  amount in Play Console), against Apple's yearly fee. Internal testing tracks are quick to use (no
  review gate: **verify**).
- **The hard parts are on Android.** Timers with the screen off, background audio, notifications and
  the glasses SDK (Kotlin first) all need native Android work. Doing them first means iOS mostly
  reuses solved problems.
- **One codebase.** React Native with Expo builds iOS from the same code later (Phase 6).

---

## Android facts that shape DualRep

| Topic | The rule today | What it means for DualRep |
|---|---|---|
| **Target API** | New apps and updates on Play must target **Android 16 (API 36)** since **Aug 31, 2026** (an extension to Nov 1, 2026 could be requested). No API 37 deadline is published; the yearly pattern suggests about Aug 31, 2027. | Expo SDK 57 already targets 36. Nothing to do. |
| **Expo SDK 57 defaults** | compileSdk **36**, targetSdk **36**, minSdk **24** (Android 7), Build-Tools **36.0.0**, NDK **27.1.12297006**, CMake **3.30.5**, AGP 8.12.0, Kotlin 2.1.20, Gradle 9.3.1, **JDK 17**. React Native's New Architecture is mandatory (it can't be turned off since RN 0.82). | Leave the SDK levels at Expo's defaults. Install exactly these SDK parts for local builds ([SETUP.md](SETUP.md#2-set-up-your-windows-pc)). |
| **16 KB memory pages** | Apps targeting API 35+ must support 16 KB page sizes on 64-bit devices. **From Feb 1, 2027, updates that don't support 16 KB can't be released.** | React Native's own code is ready. Every third-party native library (PowerSync's SQLite core, op-sqlite, later the glasses SDK) must be checked on each release build. The GitHub APK build checks every library and fails if one isn't aligned; EAS builds are checked by hand ([0.7](#07-16-kb-page-size-check)). |
| **Edge-to-edge** | At target 36 the opt-out is gone: the status and navigation bars are always transparent and the app draws behind them. | Every screen uses safe-area insets. Test with both gesture navigation and 3-button navigation. |
| **Large screens** | At target 36, on screens 600 dp or wider (tablets, foldables), orientation locks and aspect-ratio limits are ignored. The temporary opt-out disappears at API 37. | "Portrait only" won't hold on a tablet. Layouts must stretch. |
| **Predictive back** | Enabled by default at target 36, but Expo writes `android:enableOnBackInvokedCallback="false"` unless `android.predictiveBackGestureEnabled` is `true`. | Leave it off for now (Expo's default; react-native-screens compatibility was the reason). Revisit at each SDK upgrade. |
| **Developer verification** | Enforcement started **Sep 30, 2026** in Brazil, Indonesia, Singapore and Thailand, for installs on certified devices. It expands **globally in 2027**. Apps on Play with Play App Signing are registered automatically. ADB installs are not affected. | Testers should install from **Play testing tracks**, not sideloaded APK links. Sideloaded dev/preview APKs may need registering in 2027 (**verify** the steps then). |
| **Closed testing for new personal accounts** | A **personal** Play developer account created after Nov 13, 2023 needs a closed test with **at least 12 testers opted in for 14 days in a row** before it can publish to production. | Plan 3+ weeks for it and recruit 15–20 testers, so dropouts don't reset the clock. |
| **Organization accounts** | An **organization** account needs a **D-U-N-S number** (free, but it "can take up to 28 days"). Organization accounts appear to skip the 12×14 rule (from third-party sources; Google's text scopes the rule to personal accounts: **verify**). | Decide in Phase 0 because of the lead time ([Phase 0 checklist](#05-play-console-account-decide-now)). |
| **Play Billing** | Play Billing Library **8+** is required for new apps and updates since Aug 31, 2026. PBL 8 support ends **Aug 31, 2027**, so PBL 9 is needed by then (inferred from Google's deprecation table). | RevenueCat's current React Native SDK uses PBL 8.3.0. Track their releases before Aug 2027. |

### What the repo does today

| Setting | Where | Value |
|---|---|---|
| SDK levels | Expo defaults (not overridden) | compile 36 / target 36 / min 24 |
| Native project | Generated by `npx expo prebuild` (Continuous Native Generation); `/android` is gitignored | Never edit `android/` by hand; change `app.config.ts` or a config plugin |
| CI APK build | [`.github/workflows/android.yml`](../.github/workflows/android.yml) | Builds an arm64 APK, runs [`scripts/check-16kb.sh`](../scripts/check-16kb.sh) (zip alignment and ELF alignment of every 64-bit native library; the build fails if either is off), and lists the APK's permissions in the run summary. Its runs on 2026-10-08 compiled the release (preview) APK cleanly under Expo SDK 57, PowerSync's and op-sqlite's native code included. |
| Variants | [`app.config.ts`](../app.config.ts), chosen by `APP_VARIANT` (set per profile in [`eas.json`](../eas.json)) | `development` → `com.interverse.dualrep.dev`, scheme `dualrep-dev`; `preview` → `com.interverse.dualrep.preview`, scheme `dualrep-preview`; `production` → `com.interverse.dualrep`, scheme `dualrep`. All three install side by side. |
| Build types | `eas.json` | `development` and `preview` build APKs for internal distribution; `production` builds an app bundle (AAB) with a remotely incremented `versionCode` |
| Removed permissions | `android.blockedPermissions` | `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, `RECORD_AUDIO`, `USE_BIOMETRIC` and `USE_FINGERPRINT` (pulled in through expo-secure-store; DualRep doesn't use biometrics), and `SYSTEM_ALERT_WINDOW` except in development builds (the dev client's overlay needs it) |
| Backups | `android.allowBackup: false` | The auth session and local database stay out of Android cloud backups |
| Predictive back | `android.predictiveBackGestureEnabled: false` | Off, as recommended below |
| Orientation | `orientation: 'portrait'` | Phones stay portrait; screens must still work in landscape on ≥ 600 dp devices |
| R8 shrinking | `expo-build-properties` with no options | Off for now ([DECISIONS.md](DECISIONS.md) D11) |
| Notifications | `expo-notifications` 57.0.22 (Phase 1), config plugin in `app.config.ts` | The end-of-block alert: a scheduled local notification on the channel `timers-v1`, small icon `assets/notification-icon.png`. No foreground service, no exact alarms ([1.1](#11-the-focus-timer-scheduled-notification-not-a-foreground-service)) |
| Screen on | `expo-keep-awake` 57.0.2 (Phase 1) | Only during a move block ([1.4](#14-screen-on-during-sets)) |
| Audio | not installed | No `expo-audio` until Phase 2, so no foreground services yet |
| Play submission | `eas.json` → `submit.production` | Internal track, draft release, service-account key at `./secrets/play-service-account.json` (gitignored by name pattern) |
| Icons and splash | `assets/` | Placeholder art from the Expo template; brand art is pending ([5.9](#59-brand-art-and-store-listing-assets)) |

### Permission ledger

Every permission in the final (merged) manifest drives a Play Console declaration or a Data safety
answer, so add them on purpose. The CI APK build prints the list on every run. A development build
has a few more from the dev client (for example `SYSTEM_ALERT_WINDOW` for its overlay); it never goes
to Play.

- **Phase 0** preview APK: exactly `INTERNET`, `VIBRATE` and the app's own
  `com.interverse.dualrep.preview.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`.
- **Phase 1** preview APK (the CI build of 2026-10-08 with the Phase 1 packages): those three, plus
  `RECEIVE_BOOT_COMPLETED` and `POST_NOTIFICATIONS` (expo-notifications), and some extras that come
  with expo-notifications' own dependencies: `ACCESS_NETWORK_STATE`, `WAKE_LOCK` and
  `com.google.android.c2dm.permission.RECEIVE` (Firebase Cloud Messaging, for push), Google's
  install-referrer permission (expo-application, which expo-notifications depends on), and 16
  launcher "badge" permissions (`READ_APP_BADGE` and vendor ones from Samsung, Huawei, Oppo, HTC, Sony
  and others, for the count on the app icon). None of the extras asks the user anything, and DualRep
  uses neither push nor badges yet. Whether to remove them with `blockedPermissions` is an open
  Phase 1 decision ([roadmap](ROADMAP.md#phase-1-core-loop)); if you do, check that the end-of-block
  alert still rings.

| Permission | Added by | Phase | Asks the user? | Play Console |
|---|---|---|---|---|
| `INTERNET` | template | 0 | no | nothing |
| `VIBRATE` | template, expo-haptics | 0 | no | nothing |
| `<package>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | AndroidX (a signature permission only the app itself holds) | 0 | no | nothing |
| `SYSTEM_ALERT_WINDOW`, `READ/WRITE_EXTERNAL_STORAGE` | template | — | — | **remove** with `android.blockedPermissions` |
| `USE_BIOMETRIC`, `USE_FINGERPRINT` | expo-secure-store (through its AndroidX Biometric dependency; DualRep doesn't use biometrics) | — | — | **remove** with `android.blockedPermissions` |
| `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED` | expo-notifications | 1 (in) | `POST_NOTIFICATIONS` yes (Android 13+), asked when the first study block starts ([1.2](#12-notification-permission-and-channels)) | nothing |
| `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, `com.google.android.c2dm.permission.RECEIVE` | Firebase Cloud Messaging, through expo-notifications | 1 (in) | no | nothing (**verify**); push itself is Phase 4 |
| `com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE` | Google's Install Referrer library, through expo-application (a dependency of expo-notifications) | 1 (in) | no | nothing (**verify**) |
| `READ_APP_BADGE` and 15 vendor launcher badge permissions | ShortcutBadger, through expo-notifications | 1 (in) | no | nothing (**verify**); candidates for `blockedPermissions` |
| `SCHEDULE_EXACT_ALARM` (optional) | `android.permissions` | 1 | special-access settings screen | believed none (**verify**) |
| `USE_EXACT_ALARM` | — | — | — | **don't declare** |
| `RECORD_AUDIO` | expo-audio / expo-speech-recognition | 2 | yes | Data safety (audio) |
| `CAMERA` | expo-image-picker (its library manifest) | 2 | yes, when taking a photo ([2.7](#27-camera-and-photo-access)) | Data safety (photos) if uploaded |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK` | expo-audio (**on by default**) | 2 | no | **foreground-service declaration + video** |
| `FOREGROUND_SERVICE_MICROPHONE` | expo-audio `enableBackgroundRecording` | 2 | no (needs `RECORD_AUDIO`) | **foreground-service declaration + video** |
| `health.WRITE_EXERCISE` (+ `READ_*` if needed) | `android.permissions` | 3 | Health Connect screen | Health apps form + data types |
| `BLUETOOTH_CONNECT`, `BLUETOOTH` | Meta glasses SDK | 7 | `BLUETOOTH_CONNECT` yes (Android 12+) | Data safety as applicable |
| `com.android.vending.BILLING` | Play Billing (RevenueCat) | 5 | no | nothing (**verify**) |

---

## Android checklist by phase

Each item says **what** to do, **why**, **how** (with a config snippet where it helps) and **when**.
Snippets are written for `app.config.ts` (`expo.android` fields and `plugins`). Packages a snippet
needs that aren't installed yet are added in that phase with `npx expo install <package>`.

### Phase 0: Foundation

#### 0.1 Development build, not Expo Go
- **What:** run DualRep as a development build (an APK with DualRep's native code plus the Expo dev
  client).
- **Why:** PowerSync's database (op-sqlite) is native code. Expo Go can't load it.
- **How:** three ways, all in [SETUP.md](SETUP.md#9-build-the-app-and-put-it-on-your-phone): EAS cloud
  build (free tier), a local build with `npm run android`, or the GitHub Actions APK.
- **When:** now.

#### 0.2 Leave the SDK levels alone
- **What:** don't override compileSdk, targetSdk or minSdk.
- **Why:** Expo SDK 57's defaults (36 / 36 / 24) already meet Play's rules. Later phases raise minSdk
  only when a feature needs it (Health Connect needs 26, the glasses SDK needs 29).
- **How:** if you ever must, use `expo-build-properties` (already installed):
  ```ts
  plugins: [['expo-build-properties', { android: { minSdkVersion: 26 } }]],
  ```
- **When:** now; revisit in Phases 3 and 7.

#### 0.3 Edge-to-edge and insets in the design tokens
- **What:** every screen pads for the status bar and navigation bar using safe-area insets.
- **Why:** at target 36 the app always draws behind the system bars.
- **How:** `react-native-safe-area-context` (installed) with `SafeAreaView` or `useSafeAreaInsets()`;
  test with gesture navigation **and** 3-button navigation, and in dark mode.
- **When:** now (design tokens), and on every new screen.

#### 0.4 Keep the manifest lean
- **What:** remove the permissions the Expo template adds but DualRep doesn't use.
- **Why:** each permission becomes a Play declaration or a Data safety answer.
  `android.permissions` only adds; it never removes.
- **How:** `android.blockedPermissions` writes `tools:node="remove"` into the manifest. Already in
  `app.config.ts`:
  ```ts
  android: {
    allowBackup: false, // keep auth tokens and the local database out of Android cloud backups
    blockedPermissions: [
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.RECORD_AUDIO',
      // expo-secure-store declares these for biometric-protected items; DualRep never uses them.
      'android.permission.USE_BIOMETRIC',
      'android.permission.USE_FINGERPRINT',
      // The development client's overlay needs it, so only dev builds keep it.
      ...(variant === 'development' ? [] : ['android.permission.SYSTEM_ALERT_WINDOW']),
    ],
  },
  ```
  Remove `RECORD_AUDIO` from this list in Phase 2, when audio study mode needs it.
- **When:** done; check the CI permission list on every build. Phase 1's expo-notifications brought
  in notification permissions and some extras (push, install referrer, launcher badges): see the
  [permission ledger](#permission-ledger).

#### 0.5 Play Console account: decide now
- **What:** choose a **personal** or an **organization** Play developer account, and create the app
  entry for the package name to reserve it.
- **Why:** lead times. A D-U-N-S number (needed for an organization account) can take up to 28 days. A
  personal account means a 12-tester, 14-day closed test before production.
- **How:**
  1. If Interverse is a registered business, request a free D-U-N-S number first, then open an
     organization account. Otherwise open a personal account.
  2. Complete Play Console identity verification. Apps that use Play App Signing are then registered
     for Android developer verification automatically.
  3. Create the app for `com.interverse.dualrep` (no listing needed yet).
- **When:** Phase 0 (it is in the [roadmap](ROADMAP.md) as a decision).

#### 0.6 Cleartext HTTP only in debug builds
- **What:** debug (development) builds may call `http://` addresses; release builds may not.
- **Why:** the Expo template's debug manifest sets `usesCleartextTraffic="true"`, so a dev build can
  reach a local `supabase start` over your Wi-Fi. Preview and production builds can't.
- **How:** point preview builds at the hosted Supabase project (HTTPS). Nothing to configure.
- **When:** whenever you build a preview APK.

#### 0.7 16 KB page size check
- **What:** confirm every 64-bit native library in the APK or AAB supports 16 KB memory pages. Two
  things must hold, and either one alone is not enough:
  1. **Zip alignment:** each library is stored uncompressed at a 16 KB boundary inside the APK.
  2. **ELF alignment:** each library's LOAD segments are aligned to at least 16 KB (`2**14`). This is
     the part a third-party prebuilt library gets wrong.
- **Why:** from Feb 1, 2027 Play rejects updates that aren't, and on a 16 KB device a sideloaded APK
  with a misaligned library fails to load it.
- **How (automatic):** [`scripts/check-16kb.sh`](../scripts/check-16kb.sh) runs both checks on every
  arm64 (and x86_64) library in an APK. The GitHub Actions APK build ([SETUP §10](SETUP.md#10-optional-the-github-actions-apk))
  runs it on every APK it builds and **fails** if either check fails; the step's log names the
  library. Every library passed on 2026-10-08, PowerSync's SQLite core and op-sqlite included.
- **How (by hand, for an EAS build):** EAS compiles the same native libraries, but check what you
  ship. Download the APK from the EAS build page. In PowerShell, in the folder that holds it (this
  needs Build-Tools 36.0.0 and NDK 27.1.12297006 from
  [SETUP §2 step 4](SETUP.md#step-4-android-studio-and-the-sdk-parts)):
  ```powershell
  $apk = "app.apk"   # the APK's file name
  # 1. Zip alignment. The last line must say "Verification successful".
  & "$env:ANDROID_HOME\build-tools\36.0.0\zipalign.exe" -c -P 16 -v 4 $apk
  # 2. ELF alignment. Unpack the libraries; every LOAD line must end in "align 2**14" (or higher).
  Copy-Item $apk apk-contents.zip
  Expand-Archive apk-contents.zip -DestinationPath apk-contents -Force
  $objdump = "$env:ANDROID_HOME\ndk\27.1.12297006\toolchains\llvm\prebuilt\windows-x86_64\bin\llvm-objdump.exe"
  Get-ChildItem apk-contents\lib\arm64-v8a\*.so | ForEach-Object {
    $_.Name
    & $objdump -p $_.FullName | Select-String -Pattern "LOAD"
  }
  ```
  A LOAD line ending in `2**13`, `2**12` or lower means that library is not 16 KB aligned.
- **How (by hand, for an AAB):** production builds are app bundles, and Play makes the APKs from
  them. Convert the bundle with **bundletool** first (it needs Java; the JDK 17 from
  [SETUP §2 step 3](SETUP.md#step-3-jdk-17) works):
  1. Download `bundletool-all-1.18.3.jar` (or a newer version) from
     https://github.com/google/bundletool/releases into the folder that holds the AAB.
  2. Run (with the AAB's file name in place of `app.aab`):
     ```powershell
     java -jar bundletool-all-1.18.3.jar dump config --bundle=app.aab | Select-String alignment
     java -jar bundletool-all-1.18.3.jar build-apks --bundle=app.aab --output=app.apks --mode=universal
     Copy-Item app.apks app-apks.zip
     Expand-Archive app-apks.zip -DestinationPath app-apks -Force
     ```
     The first line must show `PAGE_ALIGNMENT_16K`. The last two unpack `universal.apk`, one APK
     built from the bundle.
  3. Run the two APK checks above with `$apk = "app-apks\universal.apk"`.
- **On Linux or WSL** (with `unzip`, `readelf` from binutils, and zipalign from the Android
  build-tools), `bash scripts/check-16kb.sh app.apk` runs both checks at once: it prints
  `check-16kb: OK (...)`, or a `FAIL` line per problem. Point it at zipalign with `ZIPALIGN=<path>`,
  or set `ANDROID_HOME` to an SDK that has build-tools.
- Android Studio's APK Analyzer (Build → Analyze APK) also shows an **Alignment** column for `lib/`,
  and Play Console's App bundle explorer warns about 16 KB problems after an upload.
- **When:** every preview and production build.

#### 0.8 Schema ready for account deletion
- **What:** every user-owned table cascades from `auth.users`, and no foreign key lets anyone else's
  data block a delete.
- **Why:** Play requires account deletion before launch. Deleting the `auth.users` row is one admin
  call that removes all of that person's data. Rows other people own that pointed at it (a set logged
  against their shared exercise, for example) are kept, with that link set to null.
- **How:** done in the first migration, and tested in `supabase/tests/09_deletion.test.sql`: a
  single `delete from auth.users` works even when others logged sets against your exercises, you own
  groups holding members' shared exercises, or an outsider referenced your exercise. Deleting a group
  never deletes members' exercises ([DATA_MODEL.md](DATA_MODEL.md#1-ground-rules-every-table)).
- **When:** done.

#### 0.9 Run the gate on the phone
- **What:** a row created in airplane mode reaches Postgres after reconnecting.
- **Why:** it is the Phase 0 gate.
- **How:** [SETUP.md](SETUP.md#12-run-the-sync-check-the-phase-0-gate). Also run it once on a
  **preview (release) build** against the hosted project, to prove release networking works.
- **Don't** add a `dataSync` foreground service for syncing: Android 15+ caps it at 6 hours per day
  and Play needs a declaration. PowerSync syncs whenever the app is open.
- **When:** end of Phase 0.

### Phase 1: Core loop

**Status (2026-10-08):** 1.1, 1.2 and 1.4 are built. 1.3 and 1.5 are optional and deferred. 1.6
waits for the Play Console app. How to run the gate on the phone:
[SETUP §16](SETUP.md#16-phase-1-the-core-loop-on-your-phone).

#### 1.1 The focus timer: scheduled notification, not a foreground service
- **Status: built.** The final call waits for the delay measurement ([DECISIONS.md](DECISIONS.md)
  D8, D28).
- **What:** keep time from the clock and alert with a scheduled notification.
  1. When a block starts, store `endsAt` (epoch ms) locally (the cycle's state in the local-only
     `local_state` table).
  2. The screen shows `endsAt - Date.now()`, recomputed every second while the cycle screen is open
     and at once when the app returns to the foreground.
  3. Schedule a local notification for `endsAt` on the high-importance channel `timers-v1`, with
     sound and vibration. Pause, **End block early**, **Finish** and the handoff cancel it (and clear
     it from the shade); Resume schedules it again under the same id.
- **Why:** nothing has to run while the screen is off, so there is nothing to keep alive.
- **How it differs from the plan:** the plan says "the focus timer runs in a foreground service". The
  trade-off:

  | | Scheduled notification (built) | Foreground service |
  |---|---|---|
  | Keeps time with the screen off | Yes (time comes from the clock) | Yes |
  | Alert exactly on time | Only with exact alarms allowed; otherwise Android may delay it in Doze (measure it) | Usually (the running service keeps the app alive) |
  | Live countdown in the notification shade | Optional, via a small native module (1.5) | Yes |
  | Play Console | Nothing to declare | `specialUse` type, a declaration, a demo video, and rejection risk (Play rejects services whose work "can be interrupted or deferred") |
  | Android 17 background audio | Notification sounds are played by the system, unaffected | App audio needs the service to be running |
  | Code | Small | A native service module |

  Other foreground-service types don't fit: `shortService` is capped at about 3 minutes, `health`
  needs body-sensor or activity-recognition permissions, and `systemExempted` is for system apps.
- **How (as built):** [`src/features/timer/notifications.ts`](../src/features/timer/notifications.ts).
  ```ts
  // app.config.ts: the config plugin (adds POST_NOTIFICATIONS and RECEIVE_BOOT_COMPLETED)
  plugins: [['expo-notifications', {
    icon: './assets/notification-icon.png', // white silhouette on transparent
    color: '#3A55A4',
  }]],
  ```
  ```ts
  // At startup: the channel. Users own a channel's settings once it exists, so the id is versioned.
  await Notifications.setNotificationChannelAsync('timers-v1', {
    name: 'Block timers',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 300, 200, 300],
    enableVibrate: true,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    sound: 'default',
  });
  // When a block starts (the id is ours, so scheduling again replaces it):
  await Notifications.scheduleNotificationAsync({
    identifier: `block-end-${blockId}`,
    content: { title: 'Focus block done', body: 'Time to move: your 10-minute circuit is ready.',
      data: { url: '/cycle', kind: 'block-end' }, sound: 'default' },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: endsAt, channelId: 'timers-v1' },
  });
  ```
  - Tapping the alert opens `data.url` (the cycle screen), whether the app was running or not. Only
    paths inside the app are opened.
  - While the cycle screen is open the alert stays silent: the screen hands off by itself, with a
    haptic. On any other screen it shows as usual.
  - Nothing here throws: no permission just means no alert, and the on-screen timer still works.
  - The default sound, no custom sound file. A different sound later needs a new channel id
    (`timers-v2`).
- **Verify on the phone:** start a 10-minute block, lock the phone. It should ring when the block
  ends, and tapping the alert should open the first exercise. Then run the **Timer check** (Today →
  More): 25 minutes, the phone unplugged, locked and still. It shows how late the alert came
  ([SETUP §16 step 6](SETUP.md#step-6-measure-the-alert-delay-the-timer-check)).
- **When:** built in Phase 1. Record the measured delay in the roadmap, then make the final call
  (D8, D28).

#### 1.2 Notification permission and channels
- **Status: built.**
- **What:** ask for `POST_NOTIFICATIONS` in context, and create channels (`timers-v1` HIGH now; later
  `reviews`, `coach` and `social` at DEFAULT or LOW).
- **Why:** on Android 13+ notifications are off until the user allows them, and the app decides when to
  ask. If the user says no, nothing can be posted.
- **How (as built, [DECISIONS.md](DECISIONS.md) D29):**
  - The channel is created at startup, before any request (Android 13+ shows the prompt only once
    the app has a channel).
  - The app asks only when the user taps **Start focus block** and Android still allows asking. A
    one-line explanation shows on the start screen first. **Just train** never asks.
  - If the user says no, the block starts anyway, and a quiet "Alerts are off" note shows on the
    start and focus screens.
  - Settings → **End-of-block alerts** shows **On**, **Not set up** (with **Turn on alerts**), or
    **Off** (with **Open system settings**, because Android won't show the prompt again).
  - The permission is read again whenever the app comes back to the foreground.
- **Verify on the phone:** the first time you tap **Start focus block**, Android asks. (Phase 0's app
  never asked, so the Phase 1 update asks too.) If you answer no, the block still runs, the note
  appears, and Settings shows **Off** with **Open system settings**. If you answer yes, Settings
  shows **On**.
- **When:** built in Phase 1.

#### 1.3 Exact alarms (optional)
- **Status: deferred.** Only if the Timer check (1.1) shows the alert comes too late.
- **What:** let the user allow exact alarms for on-time alerts.
- **Why:** expo-notifications uses an exact alarm only when the app may schedule them; otherwise it
  falls back to an inexact one that Doze can delay. `SCHEDULE_EXACT_ALARM` is a special permission the
  user grants in Settings, and it is **off by default** on fresh installs (Android 14+).
- **How:**
  ```ts
  android: { permissions: ['android.permission.SCHEDULE_EXACT_ALARM'] },
  ```
  Show an explainer, then open the settings screen with expo-intent-launcher's
  `ActivityAction.REQUEST_SCHEDULE_EXACT_ALARM` and the **running build's own package**. It differs
  per variant (`.dev`, `.preview`, or nothing for production), so never hard-code it:
  ```ts
  import * as Application from 'expo-application';
  import * as IntentLauncher from 'expo-intent-launcher';

  await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.REQUEST_SCHEDULE_EXACT_ALARM, {
    data: `package:${Application.applicationId}`,
  });
  ```
  (expo-intent-launcher isn't installed. expo-application is only there as a dependency of
  expo-notifications; add both directly with `npx expo install expo-application expo-intent-launcher`
  before using them.)
  Checking whether it was granted (`canScheduleExactAlarms()`) needs a tiny native module, because
  expo-notifications doesn't expose it. Revoking the permission cancels pending exact alarms.
  **Don't declare `USE_EXACT_ALARM`:** it is reserved for alarm-clock and calendar apps and Play is
  likely to reject DualRep for it.
- **When:** only if 1.1's measured delay is too long.

#### 1.4 Screen on during sets
- **Status: built.**
- **What:** keep the screen awake while the user is logging sets.
- **How:** `expo-keep-awake`: `useKeepAwake()` in the move block only. The focus block and the
  countdown after the workout let the screen dim and lock as usual (the alert covers the focus block).
- **Verify on the phone:** during a workout, leave the phone untouched past its screen timeout: the
  screen stays on. During a focus block it turns off as usual.
- **When:** built in Phase 1.

#### 1.5 Live countdown in the notification shade (optional)
- **Status: deferred** (polish; not needed for the gate).
- **What:** an ongoing notification whose countdown ticks by itself.
- **Why:** nice to have; Android draws it with no app code running.
- **How:** a small local Expo module that posts a notification with `setUsesChronometer(true)`,
  `setChronometerCountDown(true)` and `setWhen(endsAt)` (expo-notifications has no chronometer). On
  Android 16+ it can ask to be shown as a **Live Update**; Google lists "starting a workout" as a fit.
  Users can swipe ongoing notifications away (Android 14+), so treat it as a convenience.
- **When:** Phase 1 polish or later.

#### 1.6 Test through Play's internal testing track
- **Status: not started.** It needs the Play Console app first ([0.5](#05-play-console-account-decide-now)).
  Until then, install the GitHub-built preview APK ([SETUP §16](SETUP.md#step-2-build-and-install-the-phase-1-app)).
- **What:** install builds from Play's internal testing track instead of APK links.
- **Why:** fast (no review gate, **verify**), and it avoids the 2027 sideloading changes.
- **When:** as soon as the Play Console app exists.

### Phase 2: Study engine and audio study mode

#### 2.1 Foreground services for audio study mode
- **What:** on-the-go mode plays questions aloud and listens for answers with the screen off.
- **Why:** this one really needs foreground services:

  | Need | Service type | Manifest permission | Condition |
  |---|---|---|---|
  | Text-to-speech playback, lock-screen and headset controls | `mediaPlayback` | `FOREGROUND_SERVICE_MEDIA_PLAYBACK` | none |
  | Speech recognition with the screen off | `microphone` | `FOREGROUND_SERVICE_MICROPHONE` | `RECORD_AUDIO` granted |

- **How:** start both services when the user taps "Start audio study" **while the app is in the
  foreground**, and keep them running for the whole session. A `microphone` service can't be started
  from the background (it throws a `SecurityException`), so don't try to restart it from a headset
  press with the screen off.
  ```ts
  plugins: [['expo-audio', {
    enableBackgroundPlayback: true,
    enableBackgroundRecording: true,
    recordAudioAndroid: true,
  }]],
  ```
  Also take `android.permission.RECORD_AUDIO` out of `android.blockedPermissions` in
  `app.config.ts`; Phase 0 blocks it.
- **When:** Phase 2.

#### 2.2 The expo-audio defaults trap
- **What:** if `expo-audio` is added **before** Phase 2 (for example for UI sounds), turn its
  background features off.
- **Why:** its config plugin defaults are `enableBackgroundPlayback: true` and
  `recordAudioAndroid: true`. Listing the plugin without options silently ships a media foreground
  service and `RECORD_AUDIO`, which trigger a Play foreground-service declaration with a video and
  Data safety audio questions.
- **How:**
  ```ts
  plugins: [['expo-audio', { enableBackgroundPlayback: false, recordAudioAndroid: false }]],
  ```
- **When:** any phase that adds expo-audio before audio study mode.

#### 2.3 Android 17 background audio
- **What:** on **Android 17 (every app, whatever its target)**, audio from a backgrounded app is
  silenced unless an activity is visible or a non-`shortService` foreground service runs. Apps
  targeting API 37 also need that service to have "while-in-use" capability, i.e. started from the
  foreground.
- **How:** run the `mediaPlayback` service for the whole session (Google recommends media3
  `MediaSessionService`). Test with `adb shell cmd audio set-enable-hardening enable` (or `throw`).
- **When:** Phase 2, and again at the API 37 target bump (likely Aug 2027).

#### 2.4 Speech in the background: spike first
- **What:** prove screen-off speech recognition and text-to-speech before building the mode.
- **Why:** unverified on Android 14–17. `expo-speech-recognition` (Android `SpeechRecognizer`) adds
  `RECORD_AUDIO` but no foreground service; whether system TTS from a backgrounded app survives
  Android 17's rules is unknown.
- **How:** a one-day spike with the `mediaPlayback` service running. Fallback: record with expo-audio
  inside the `microphone` service and send clips to Tracy for speech-to-text. Headset next/previous
  mappings need a local module around media3, because expo-audio's media session removes those
  commands.
- **When:** start of Phase 2.

#### 2.5 Review reminders and background sync
- **What:** a daily "reviews due" reminder; optional background sync.
- **How:** an inexact `DAILY` trigger on a `reviews` channel (no exact alarm needed). For periodic sync,
  `expo-background-task` (WorkManager, roughly every 15 minutes at best), **not** a `dataSync`
  foreground service.
- **When:** Phase 2.

#### 2.6 Play declarations for audio mode
- **What:** the foreground-service declaration (one demo video per type) and the Data safety audio
  answer.
- **How:** video: start audio study in the foreground → lock the screen → speech continues → answer by
  voice or headset. Data safety: "Audio files → Voice or sound recordings" if any audio leaves the
  phone.
- **When:** before the first build with audio mode reaches a Play track.

#### 2.7 Camera and photo access
- **What:** the upload flow takes a photo with the camera or picks one from the gallery (photos of
  handwritten notes).
- **Why:** taking a photo needs the `CAMERA` runtime permission. Picking from the gallery needs no
  permission if it uses the system photo picker. Play's Photo and Video Permissions policy requires a
  declaration for broad photo access (`READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`), which DualRep doesn't
  need.
- **How:** use `expo-image-picker` (add it with `npx expo install expo-image-picker`):
  - `launchImageLibraryAsync()` opens the system photo picker and needs no permission.
  - `launchCameraAsync()` needs `CAMERA`, which expo-image-picker's library manifest adds. Ask in
    context with `requestCameraPermissionsAsync()` when the user taps "Take a photo", and keep the
    file and gallery paths working when they say no.
  - Its config plugin also adds `RECORD_AUDIO` unless told not to:
    ```ts
    plugins: [['expo-image-picker', { microphonePermission: false }]],
    ```
    (Leave that option out once audio study mode needs `RECORD_AUDIO` anyway.)
  - Never add `READ_MEDIA_IMAGES` or `READ_MEDIA_VIDEO` (for example through expo-media-library).
  - The Data safety answer for photos is in [5.5](#55-data-safety-draft).
- **When:** Phase 2, with the upload flow.

### Phase 3: Tracy coaching

#### 3.1 Report button on AI output
- **What:** a "Report this response" action on Tracy's messages, stored through an Edge Function.
- **Why:** Play's AI-generated content policy requires in-app reporting of AI output without leaving
  the app (**verify** the current wording).
- **When:** Phase 3.

#### 3.2 Health claims and the disclaimer
- **What:** say what the app does, never what it treats.
- **Why:** Play's health policy prohibits misleading health claims, and non-medical apps need a
  disclaimer that the app "is not a medical device and does not diagnose, treat, cure, or prevent any
  medical condition" (from a policy preview: **verify** the exact wording in Play Console).
- **How:** never write "treats/manages ADHD", "ADHD therapy", "clinically proven" or "alternative to
  medication". Describe mechanics: "short focus blocks", "quiz-first study", "movement breaks". Put the
  disclaimer in onboarding, About, the coach screen and the store description, plus an exercise-safety
  line. Tracy's prompt refuses diagnosis and medication advice.
- **When:** Phase 3 for in-app text; Phase 5 for the listing.

#### 3.3 Health apps declaration
- **What:** pick the category in Play Console → App content → Health apps.
- **How:** declare **Activity and fitness** (and possibly "Stress management, relaxation, mental
  acuity"). Avoid the medical categories unless you want the stricter rules. The privacy policy must be
  a public web page, not a PDF.
- **When:** Phase 3 (declare by Phase 5).

#### 3.4 Health Connect (optional)
- **What:** write finished workouts to Health Connect as `ExerciseSessionRecord`
  (`EXERCISE_TYPE_STRENGTH_TRAINING` or `EXERCISE_TYPE_WEIGHTLIFTING`).
- **Why:** users see DualRep workouts in their other fitness apps.
- **How:** needs API 26+.
  ```ts
  android: { permissions: ['android.permission.health.WRITE_EXERCISE'] },
  plugins: [
    ['expo-build-properties', { android: { minSdkVersion: 26 } }],
    'react-native-health-connect', // adds the permissions-rationale screen Health Connect requires
  ],
  ```
  The data types declared in Play Console must match the manifest. Approval can take up to 7 days.
- **When:** Phase 3 or later; not needed for the gate.

### Phase 4: Friends

#### 4.1 User-generated content controls
- **What:** separate, clearly labelled **report content**, **report user** and **block user** controls,
  plus terms the user accepts before sharing.
- **Why:** Play's user-generated content policy; rejections have cited a missing "report user" control.
- **When:** Phase 4.

#### 4.2 Push notifications for friend activity
- **What:** push through Firebase Cloud Messaging on a `social` channel (DEFAULT or LOW).
- **How:** `android.googleServicesFile` in the app config and FCM v1 credentials in EAS (**verify** the
  current Expo steps).
  - `google-services.json` is in `.gitignore`, so EAS cloud builds and the GitHub APK build never
    get the file, and the build fails at prebuild ("Cannot copy google-services.json"). Store it in
    EAS as a file variable:
    ```powershell
    eas env:set --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --environment development --environment preview --environment production --visibility sensitive
    ```
    and point the config at it, with the local file as the fallback:
    ```ts
    android: { googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? './google-services.json' },
    ```
  - The GitHub APK workflow needs the same file (for example from a repository secret), or it must
    leave `googleServicesFile` out.
- **When:** Phase 4.

#### 4.3 Data safety additions and the deletion flow
- **What:** add Personal info (name, user IDs), App activity (user-generated content) and Photos if
  shared. Build the account-deletion flow now so it can be tested before launch (5.6).
- **When:** Phase 4.

#### 4.4 Invite links (only if verified App Links are chosen)
- **What:** an invite link such as `https://<your domain>/join/<code>` opens DualRep directly
  (ROADMAP Phase 4 decision: custom scheme or verified App Links).
- **Why:** Android only opens an `https` link in the app without asking when the app is **verified**
  for that domain; otherwise the link opens in the browser.
- **How:**
  - Add an intent filter with `autoVerify` in `app.config.ts`:
    ```ts
    android: {
      intentFilters: [{
        action: 'VIEW',
        autoVerify: true,
        data: [{ scheme: 'https', host: '<your domain>', pathPrefix: '/join' }],
        category: ['BROWSABLE', 'DEFAULT'],
      }],
    },
    ```
  - Host `https://<your domain>/.well-known/assetlinks.json` listing the package names and the
    SHA-256 fingerprints of every key that signs a build you install: the Play app-signing key (Play
    Console → Test and release → Setup → App signing; **verify** the menu path), the EAS upload key
    (`eas credentials`) and the debug key the GitHub APK uses.
  - Keep the custom scheme (`dualrep://`) working as a fallback.
- **When:** Phase 4, only if App Links are chosen.

### Phase 5: Android launch

#### 5.1 Production access
- **What:** a personal account runs a closed test with **≥ 12 opted-in testers for 14 consecutive
  days**, then applies for production from the Dashboard. An organization account is believed exempt
  (**verify**).
- **How:** start the closed test at least 3 weeks before the target date; recruit 15–20 testers so the
  count never drops below 12.
- **When:** start of Phase 5 (or earlier).

#### 5.2 Signing and EAS Submit
- **What:** Play App Signing (required for new apps): you sign with an upload key, Google re-signs.
  EAS manages the upload key.
- **How:**
  1. In Google Cloud, create a service account and enable the **Google Play Android Developer API**.
  2. In Play Console → Users and permissions, invite the service-account email with release rights
     for DualRep.
  3. Keep its JSON key out of git (`play-service-account*.json` is already in `.gitignore`) or store
     it in EAS.
  4. Point production builds at the **production** backend (ROADMAP Phase 5: a separate Supabase
     project and PowerSync instance, for example `dualrep-prod`, set up like
     [SETUP §5–8](SETUP.md#5-create-the-supabase-project-and-push-the-database)). The values in
     EAS so far are for the `development` and `preview` environments only, and `.env` never
     reaches EAS, so without this step every tester sees "Setup needed":
     ```powershell
     eas env:set --name EXPO_PUBLIC_SUPABASE_URL --value https://<prod-project-ref>.supabase.co --environment production --visibility plaintext
     eas env:set --name EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY --value <prod sb_publishable_...> --environment production --visibility plaintext
     eas env:set --name EXPO_PUBLIC_POWERSYNC_URL --value https://<prod-instance-id>.powersync.journeyapps.com --environment production --visibility plaintext
     eas env:list --environment production
     ```
     The list shows the three values and `EAS_PROJECT_ID`.
  5. `eas build -p android --profile production`, then
     `eas submit -p android --profile production` (the `eas` command is installed in
     [SETUP.md](SETUP.md#2-set-up-your-windows-pc)).
  Expo's docs disagree on whether the very first upload must be manual (**verify**). If the API refuses
  it, upload the first AAB by hand to Internal testing. Keep `releaseStatus: "draft"` until the app has
  been published once.
- **When:** Phase 5.

#### 5.3 Billing through RevenueCat
- **What:** subscriptions with `react-native-purchases`, which uses Play Billing Library 8.3.0 (meets
  today's PBL 8 rule).
- **How:** test on a development build with license testers (Expo Go's mock mode makes no real
  purchases). RevenueCat ↔ Play setup (service-account permissions, real-time developer notifications)
  was not researched: follow RevenueCat's docs (**verify**). Entitlements reach the app through the
  `entitlements` table, written by a RevenueCat webhook Edge Function.
- **When:** Phase 5. Watch for PBL 9 support before **Aug 31, 2027**.

#### 5.4 App content declarations

| Declaration | Notes |
|---|---|
| Privacy policy | A public URL |
| App access | A reusable review login ([5.8](#58-reviewer-login-app-access)): Google requires credentials that work at any time and skip one-time codes, so an emailed code is not enough. Choose "All or some functionality is restricted" and enter the review account's email and password, plus the steps to sign in with a password |
| Ads, content rating, target audience | Standard questionnaires |
| Data safety | Draft in 5.5 |
| Account deletion URL | 5.6 |
| Health apps | 3.3 |
| Foreground services + videos | Only if audio mode ships (2.6) |
| Health Connect data types | Only if 3.4 ships |
| Store listing | Medical disclaimer in the description (3.2) |

#### 5.5 Data safety draft

| Category → type | Where it comes from in DualRep | Likely answer (**verify** with Google's definitions) |
|---|---|---|
| Personal info → email address, user IDs (name if collected) | Supabase Auth, `profiles` | Collected; account management, app functionality |
| Health and fitness → fitness info | Workouts, sets, Health Connect writes | Collected; app functionality, personalization |
| Health and fitness → health info | Only if symptoms, diagnoses, medication or mood are stored | Avoid collecting it |
| Photos and videos → photos | Note photos, card images, avatars | Collected if uploaded |
| Files and docs | Uploaded PDFs and notes | Collected if uploaded |
| Audio → voice or sound recordings | Clips sent to Tracy for speech-to-text | Collected if audio leaves the phone |
| App activity → app interactions, other user-generated content | Study and training events, cards, Tracy messages, group content | Collected |
| Financial info → purchase history | RevenueCat / Play | Likely collected |
| App info and performance → crash logs, diagnostics | Sentry, if added | Collected |
| Device or other IDs | FCM token, RevenueCat user ID | Likely collected |
| Security practices | Encrypted in transit; deletion available | Yes / Yes |

If Tracy sends user content to a third-party model provider, decide (with advice) whether that counts
as "shared" or falls under the service-provider exemption.

#### 5.6 Account deletion (required)
- **What:** an in-app way to delete the account **and** a web page where users can request deletion
  without the app. Deactivating doesn't count.
- **How:** a `delete-account` Edge Function (service role) that deletes the `auth.users` row (the
  cascades remove all of the user's data; other people's rows that pointed at it are kept, with that
  link set to null, see [0.8](#08-schema-ready-for-account-deletion)), removes the user's Storage
  files and the RevenueCat subscriber; the app then clears the local database
  (`disconnectAndClearSync()`).
- **When:** build in Phase 4, required before the Phase 5 launch.

#### 5.7 Release checks (every production build)
- [ ] targetSdk 36 (Expo default)
- [ ] 16 KB check passes on the AAB ([0.7](#07-16-kb-page-size-check), with bundletool), and Play
      Console's App bundle explorer shows no memory-page-size warning
- [ ] The production build opens on the sign-in screen, not "Setup needed" (5.2 step 4)
- [ ] The **merged manifest** has only the permissions you mean to declare (compare with the ledger
      above; the CI APK build prints them)
- [ ] Edge-to-edge screens checked with gesture and 3-button navigation, on a ≥ 600 dp emulator, in
      dark mode
- [ ] Notifications denied: the app still works
- [ ] Android 17 device or emulator for background audio (once audio mode exists)
- [ ] R8 shrinking decision made and tested ([DECISIONS.md](DECISIONS.md) D11)
- [ ] The review login (5.8) works on a production build installed from the internal track

#### 5.8 Reviewer login (App access)
- **What:** one account Google's reviewers can sign in with at any time, without an emailed code.
- **Why:** DualRep's only sign-in is a 6-digit code emailed when you ask for it; it expires in an
  hour and goes to an inbox the reviewer doesn't have. Google's App access rules ask for reusable
  credentials that bypass one-time codes (**verify** the current wording in Play Console). Supabase's
  fixed test codes are for phone sign-in only (**verify**), so email needs another way in.
- **How:**
  1. In the Supabase dashboard of the **production** project: Authentication → Users → Add user →
     Create new user (**verify** the menu names). Use a dedicated address (for example
     `play-review@<your domain>`) and a long random password, tick **Auto Confirm User**, and save
     both in your password manager.
  2. App work: add a small "Sign in with password" path to the sign-in screen that calls
     `supabase.auth.signInWithPassword({ email, password })`. Keep it out of normal users' way (for
     example production builds only, behind a long press). This is new code; nothing in the app does
     it yet.
  3. In Play Console → App content → App access, enter the email, the password and the steps.
  4. Test the login on a production build from the internal track.
- **When:** Phase 5, before the first review.

#### 5.9 Brand art and store listing assets
- **What:** replace the Expo template's placeholder art and make the Play listing assets.
- **How:**
  - App art: `assets/icon.png`, the adaptive icon layers (`assets/android-icon-foreground.png`,
    `android-icon-background.png`, `android-icon-monochrome.png`) and `assets/splash-icon.png`
    (paths from `app.config.ts`).
  - Play listing: a 512 × 512 icon, a 1024 × 500 feature graphic, phone screenshots, and the short
    and full descriptions with the disclaimer from [3.2](#32-health-claims-and-the-disclaimer)
    (**verify** the current sizes in Play Console).
- **When:** Phase 5, before the closed test.

#### 5.10 Dates to watch

| Date | What |
|---|---|
| **Feb 1, 2027** | 16 KB support required to release updates |
| **2027** | Developer verification goes global |
| **Aug 31, 2027** | Play Billing Library 9 required (inferred) |
| **~Aug 31, 2027** | Target API 37 likely (not announced). It brings while-in-use-only background audio, no large-screen orientation opt-out, an `ACCESS_LOCAL_NETWORK` runtime permission (check its effect on dev builds talking to Metro), and read-only native libraries for `System.load()`. |

### Phase 6: iOS (Android-side notes)

- Keep platform differences behind small interfaces: Health Connect vs HealthKit, exact alarms (iOS
  has none), audio sessions.
- The no-diagnosis wording and disclaimer apply on iOS too.
- Keep the app variants (development, preview, production) aligned across platforms: Android package
  names and iOS bundle IDs.

### Phase 7: Glasses (Meta Wearables Device Access Toolkit)

#### 7.1 The SDK and its Android needs
- **What:** Meta's DAT 1.0 is on **Maven Central** (`com.meta.wearable:mwdat-core`, `-camera`,
  `-display`, `-inputs`, `-motion`, `-speech`, `-mockdevice`), no GitHub token needed.
- **Android requirements** (from the `mwdat-core` 1.0.0 manifest): **minSdk 29** (Android 10),
  `BLUETOOTH_CONNECT` (runtime on Android 12+) and `BLUETOOTH`, a `<queries>` entry for the Meta AI app
  (`com.facebook.stella`), Kotlin 2.2 metadata. Its native libraries are already 16 KB aligned.
- **How:** a local Expo module (`npx create-expo-module --local`, Kotlin) wrapping DAT. Its config
  plugin adds the Maven dependency, `BLUETOOTH_CONNECT` and the app-id meta-data, and sets
  `minSdkVersion: 29` (that drops Android 7–9 users from the glasses build). If Kotlin compilation
  fails on SDK 57's Kotlin 2.1.20, set `expo-build-properties` → `android.kotlinVersion` to 2.2.x, or
  move to SDK 58 (Kotlin 2.2).

#### 7.2 Keep it out of production builds
- **What:** build the glasses module only into a separate variant (for example `APP_VARIANT=glasses`)
  or behind a build-time flag.
- **Why:** Meta's path to publishing glasses features to the public is still "coming soon"; treat
  public release as **not allowed** unless Meta approves DualRep (**verify** at the time). It would also
  raise minSdk for everyone.
- **How:** develop against the **Mock Device Kit** (`mwdat-mockdevice`, as a debug-only dependency; it
  does not simulate display glasses), then hardware. Developer Mode is turned on in the Meta AI app.
- **When:** Phase 7.
