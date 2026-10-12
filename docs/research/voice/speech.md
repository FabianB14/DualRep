# Voice notes, track `speech`: speech-to-text on the phone

Researched 2026-10-12 against `/home/user/DualRep` (Expo SDK 57.0.27, React Native 0.86.3 with the New
Architecture, `jest-expo` 57.0.5) and `/home/user/tracy-ai`. Both repos are unchanged. Every file
written for this research is under `scratchpad/voice-research/` (`scratch/` for downloads, plus two
small experiment folders, `jestcheck/` and `cfgcheck/`, described in §13 and §6).

**How each fact was checked** (each claim below carries one of these tags):

- **[S]**: read in the package itself. `npm pack expo-speech-recognition@{57.0.0,57.1.0,57.1.1}` into
  `scratch/esr-<v>/`, with all three diffed against each other. The 57.1.1 tarball's SHA-1 matches the
  registry's `shasum`, and its `android/src/main`, `src/` and `app.plugin.js` are byte-identical to a
  shallow clone of `github.com/jamsch/expo-speech-recognition` at HEAD `8b31e39` ("Version Packages
  (#184)"). The CHANGELOG is not in the tarball, so it was read from the repo.
- **[D]**: read in a primary platform source. These are developer.android.com reference and guide pages
  (`SpeechRecognizer`, `RecognizerIntent`, permissions, Android 9 and 12 behavior changes) and AOSP
  source (`SpeechRecognizer.java` at `android11-release`, `SpeechRecognizerImpl.java` and
  `SpeechRecognizer.java` at `main`, from the GitHub `aosp-mirror`).
- **[R]**: run in this sandbox. `jest-expo` with DualRep's own `node_modules` (§13), and
  `expo config --type introspect` on a scratch copy of `app.config.ts` (§6).
- **[U]**: unverified. It comes from a search excerpt, the library README's own claims, inference or
  memory. Check it on the phone or on Google's pages. support.google.com, play.google.com,
  googleblog.com, arxiv.org and reactnative.directory are all blocked from this sandbox, so **every
  Google Play policy statement here is [U]**.

Nothing here has run on an Android phone. This sandbox has no Android SDK, so the native module was not
compiled. The first CI APK build is the compile check.

---

## 0. Recommendations in brief

1. **Pin `expo-speech-recognition` at `57.1.1` exactly** (`npm install --save-exact
   expo-speech-recognition@57.1.1`). It was published 2026-10-08, only 4 days ago. The later version is
   worth it for a specific Android reason:
   - 57.1.1's only code change wraps `SpeechRecognizer.destroy()` in try/catch.
   - On Android 11 and older (DualRep supports Android 7–11, minSdk 24), `destroy()` calls
     `Context.unbindService` [D]. That call throws `IllegalArgumentException` when the recognizer never
     bound. An example is a phone with no default voice-recognition service [D].
   - In 57.1.0 the call sat outside any try, inside a main-thread `Handler.post`, so the exception
     **crashes the app** [S].
   - The auto-restart loop DualRep needs on Android ≤ 12 calls `start()` → `destroy()` every few
     seconds, so this crash path is exactly where DualRep will be.
   - I read the whole 57.1.0 → 57.1.1 diff: three hunks of try/catch plus `speech = null`.
   - It reaches two weeks on 2026-10-22. The feature won't ship before then. Re-check for a 57.1.2
     before release.
2. **Compatible with SDK 57, RN 0.86 and the New Architecture**, with one caveat:
   - It is a pure Expo Modules API module (Kotlin, JSI, no TurboModule codegen, no C++, no `.so`).
   - The APIs it uses all exist in DualRep's installed `expo-modules-core` 57.0.21 [S]. That includes
     the `@OptimizedRecord` annotation, which the SDK 57 gradle plugin handles, and `useEventListener`,
     which `expo` exports.
   - Importing it under `jest-expo` 57 works [R].
   - Caveat: the "SDK 57 support" release (57.0.0) is a changeset only, with "no breaking changes". The
     library's own example app is still on Expo 56 / RN 0.85.3 [S]. The first DualRep CI build is the
     real compile check.
3. **Android behaviour that shapes the design:**
   - **Android 13+ (API 33+):** `continuous: true` really is continuous. The library records the
     microphone itself (`AudioRecord`, `VOICE_RECOGNITION` source) and pipes the audio to the recognizer
     as a *segmented session*. That session "will end when and only when the audio is closed" [S][D].
     Results arrive as partials, then one final per segment.
   - **Android ≤ 12:** there is no continuous mode. Each session ends after a pause, so the app must
     restart on `end` while the person is still "recording". Each restart plays the system beep [S][U].
   - **On-device recognition:**
     - Guaranteed only on Android 13+ with `requiresOnDeviceRecognition: true`, which calls
       `SpeechRecognizer.createOnDeviceSpeechRecognizer` [S][D].
     - Usable only when the language model is installed:
       `getSupportedLocales().installedLocales`. `supportsOnDeviceRecognition()` only says the phone
       maker named an on-device service; it does not say a model is present [D].
     - Missing models can be fetched with `androidTriggerOfflineModelDownload`.
     - Otherwise recognition uses the phone's default service (usually a Google app), which may go
       online.
4. **Manifest:** delete one line, `'android.permission.RECORD_AUDIO'`, from `blockedPermissions`, and
   list the `expo-speech-recognition` plugin. Verified with `expo config --type introspect` [R]:
   - The **only** permission added is `RECORD_AUDIO`.
   - The plugin also adds one `<queries>` element: `<package com.google.android.googlequicksearchbox>`
     plus `<intent><action android.speech.RecognitionService>`. Android requires the latter for
     `SpeechRecognizer` when targeting API 30+ [D].
   - No services, no `FOREGROUND_SERVICE*`, no `MODIFY_AUDIO_SETTINGS`.
   - No expo-audio. The image picker never asks for `RECORD_AUDIO` at runtime [S].
5. **16 KB pages:** nothing to do. No native libraries; the only dependency is `androidx.annotation` [S].
6. **Play:**
   - Ask for the microphone in context, on the first tap of the mic.
   - `RECORD_AUDIO` isn't on the Permissions Declaration Form list as far as can be seen [U].
   - Data safety, on-device: the audio never leaves the phone, so audio is not "collected" [U: Google's
     definition from search excerpts].
   - Data safety, online fallback: audio goes from the phone's speech service (Google's app) to Google,
     never through DualRep's code or servers. Whether Play counts that as DualRep collecting audio is
     **unclear: ask for advice** (§9).
   - The transcript itself is collected either way (user-generated content).
7. **Keyboard-mic fallback** (Gboard's or Samsung Keyboard's microphone in a multiline `TextInput`):
   zero code, zero permissions, and it's how typed or pasted notes work anyway. Offer it alongside: one
   text field, with a hint that the keyboard microphone works there too. Don't make it the only path. It
   stops after pauses, DualRep can't tell whether it's online, and it varies by keyboard.
8. **Screen:**
   - One big mic button, the live transcript (partials greyed, finals committed), auto-restart while
     "recording", and auto-pause after 60 s of quiet, when the app leaves the foreground, or at the cap.
   - Text is editable whenever paused. Keep the screen awake while listening, and save the draft on the
     phone.
   - A line that says plainly "On this phone, works offline" or "Uses Google's speech service, needs the
     internet".
   - Language defaults to the phone's locale, with English variants first.
   - A cap of **20,000 characters** per note, the existing `maxTranscriptChars`.

---

## 1. Versions

| Version | Published (npm) | Age on 2026-10-12 | What changed (CHANGELOG + diff) |
|---|---|---|---|
| 56.0.4 (`sdk-56` tag) | 2026-08-28 | 45 d | "Fix Android speech recognition in minified release builds by generating optimized Expo Modules record metadata" (`@OptimizedRecord`), plus string-list intent extras as `ArrayList<String>` [S] |
| **57.0.0** | 2026-08-30 | 43 d | Changeset only: "Official support for Expo SDK 57 (React Native 0.86)… no breaking changes" [S] |
| **57.1.0** | 2026-09-16 | 26 d | Adds `timestamp` to `audiostart`/`audioend`. On Android `audiostart.uri` is `null` instead of the string `"file://null"` when not persisting. Unit-test scaffolding in `build.gradle` (testImplementation only) [S] |
| **57.1.1** (`latest`) | 2026-10-08 | **4 d** | "fix(android): catch thrown errors on `SpeechRecognizer.destroy()`; this usually only affects Android 11 and below when service cannot be unbound." Three try/catch hunks plus `speech = null` after destroy [S] |

- **Integrity of 57.1.1:** `sha512-e1RalFEvc7yui9Jnf1NiEYHT0jSPeH4hbMTafj1yjvcKN7HhZ7VrQigGUhBDB9AnDNjtPugbyPuCIjwHBBOCyw==`,
  shasum `454aa0537dac984c36cde701c92394b46011e2f4`.
- **Publisher:** GitHub Actions trusted publishing (`_npmUser: GitHub Actions`, `trustedPublisher: github`)
  with SLSA provenance attestations.
- **Peer dependencies:** `expo`, `react`, `react-native`, all `"*"`.
- **Not in Expo's `bundledNativeModules.json`**, so `npx expo install` won't pick a version. Install it
  exactly, as DualRep pins everything:
  ```bash
  npm install --save-exact expo-speech-recognition@57.1.1
  ```

**Why 57.1.1 and not 57.1.0 (more than two weeks old):** the crash is concrete.

- **Android 11 `SpeechRecognizer.destroy()`** [D, AOSP `android11-release`]:
  ```java
  if (mConnection != null) { mContext.unbindService(mConnection); }
  ```
- **`startListening()` with no default service** [D] creates `mConnection = new Connection()` first.
  Then, if `Settings.Secure.VOICE_RECOGNITION_SERVICE` is empty, it logs "no selected voice recognition
  service", calls `onError(ERROR_CLIENT)` and returns **without binding**. `mConnection` stays non-null
  but unbound, and the next `destroy()` throws `IllegalArgumentException: Service not registered`.
- **In 57.1.0 the library calls `speech?.destroy()` in two places, both unguarded:**
  - in `teardownAndEnd()`, which runs after every error and every final result;
  - at the top of `start()`, inside `mainHandler.post { … }`.
  An exception thrown inside a main-looper `Runnable` is uncaught, so the **app crashes** [S].
- **57.1.1 catches `Throwable` there and nulls the field** [S].
- Android 12+ no longer binds from the app process (it goes through the system's
  `SpeechRecognitionManagerService`, `SpeechRecognizerImpl` at `main`) [D]. That is why the CHANGELOG
  scopes the bug to "Android 11 and below".

If the two-week rule must hold strictly, use 57.1.0 until 2026-10-22, never on a build that reaches
Android ≤ 11 testers. I don't recommend that: the fix is three try/catch blocks.

---

## 2. Compatibility with Expo SDK 57, RN 0.86 and the New Architecture

- **Module type** [S]:
  - An Expo Modules API module: `expo-module.config.json` → `expo.modules.speechrecognition.ExpoSpeechRecognitionModule`.
  - Kotlin `Module()`/`ModuleDefinition`; JS calls `requireNativeModule("ExpoSpeechRecognition")` from
    `expo`.
  - Expo modules run over JSI under the New Architecture (bridgeless), which RN 0.86 makes mandatory. No
    legacy bridge module, no codegen spec needed.
- **APIs it relies on, all present in DualRep's install:**
  - `expo-modules-core` 57.0.21 has `expo.modules.kotlin.types.OptimizedRecord` (and
    `expo-module-gradle-plugin/.../ProjectConfiguration.kt` handles it).
  - `expo.modules.interfaces.permissions.Permissions.askForPermissionsWithPermissionsManager` and
    `getPermissionsWithPermissionsManager` exist.
  - `PermissionsResponse` exists.
  - `expo` exports `useEventListener` (`expo/src/Expo.ts:46`).
  - Its `android/build.gradle` uses `id 'expo-module-gradle-plugin'`, like `expo-haptics` and
    `expo-crypto` in DualRep.
- **Gradle dependencies:** none beyond what Expo brings (`androidx.annotation` only).
  `testImplementation` JUnit doesn't reach the APK.
- **R8:** DualRep keeps R8 off (D11). The 56.0.4 fix covers minified builds anyway.
- **TypeScript:** written against TS ~6.0.3, which DualRep uses (6.0.3).
- **Caveat** [S]: the repo's `example/` still runs Expo `~56.0.12` / RN 0.85.3, and the package's
  devDependency is `expo ~56.0.12`. SDK 57 support is the author's statement, not something the repo
  demonstrates. The risk is low: plain Android framework APIs plus stable Expo Modules APIs. **First CI
  APK build = compile proof.**
- **Expo Go:** it doesn't work there. DualRep already uses a dev client (ANDROID.md 0.1).

---

## 3. The JS API (57.1.1, exact)

Everything goes through the native module object, not top-level functions (removed in 3.0.0) [S]:

```ts
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,          // = useEventListener(ExpoSpeechRecognitionModule, name, fn)
  SpeechRecognizerErrorAndroid,       // native error codes
  RecognizerIntentExtraLanguageModel, // 'free_form' | 'web_search'
  type ExpoSpeechRecognitionOptions,
  type ExpoSpeechRecognitionResultEvent,
  type ExpoSpeechRecognitionErrorEvent,
} from 'expo-speech-recognition';
```

### 3.1 Control

| Call | Android behaviour [S] |
|---|---|
| `start(options): void` (synchronous) | If `RECORD_AUDIO` isn't granted, emits `error {error:'not-allowed', code:-1}` then `end`, and does nothing else. Otherwise posts to the main thread: destroys any previous recognizer, builds the intent, creates the recognizer, starts the app's own `AudioRecord` (13+ continuous only), calls `startListening`, emits `audiostart`. Any exception while building (for example a bad `androidIntentOptions` key) becomes `error {error:'audio-capture', message:<exception>}` + `end`. |
| `stop(): void` | `stopListening()`. Waits for the recognizer's final `onResults`/`onSegmentResults`/`onError`, then `audioend` + `end`. README: expect a final `result`, or `nomatch`, or `error no-speech`, then `audioend`, `end`. |
| `abort(): void` | Emits `error {error:'aborted'}` **first**, then cancels and destroys: `audioend`, `end`. No final result. |
| `getStateAsync()` | `'inactive' \| 'starting' \| 'recognizing' \| 'stopping'` |

### 3.2 Options (`ExpoSpeechRecognitionOptions`) relevant on Android

| Option | Default | Android effect [S][D] |
|---|---|---|
| `lang` | Kotlin record default `"en-US"`; `""` → `Locale.getDefault().toString()` | `EXTRA_LANGUAGE` (BCP 47). The `""` fallback gives `en_US` with an underscore, not BCP 47, so **always pass a real tag** |
| `interimResults` | `false` | `EXTRA_PARTIAL_RESULTS` ("The server may ignore a request for partial results in some or all cases" [D]) |
| `continuous` | `false` | **API 33+:** own `AudioRecord` → `EXTRA_AUDIO_SOURCE` pipe + `EXTRA_SEGMENTED_SESSION = EXTRA_AUDIO_SOURCE`. **API ≤ 32:** sets the three `EXTRA_SPEECH_INPUT_*_MILLIS` extras to 600000; the README marks this "not supported", so don't use it there |
| `requiresOnDeviceRecognition` | `false` | **API 33+:** `SpeechRecognizer.createOnDeviceSpeechRecognizer()` (throws `UnsupportedOperationException` → `audio-capture` error if none). **All APIs:** `EXTRA_PREFER_OFFLINE = true` ("Depending on the recognizer implementation, these values may have no effect" [D]) |
| `addsPunctuation` | `false` | API 33+: `EXTRA_ENABLE_FORMATTING = "quality"`. Result lists then hold "1) formatted text 2) raw text" [D]. The README says it's verified only with on-device recognition |
| `contextualStrings` | — | API 33+: `EXTRA_BIASING_STRINGS` (effect varies by recognizer [U]) |
| `androidIntentOptions` | — | Each key resolved by **reflection** `RecognizerIntent.class.getDeclaredField(key)`. **A key that doesn't exist on the phone's API level throws, so `start` fails with `audio-capture`.** Only pass API-33+ keys (for example `EXTRA_MASK_OFFENSIVE_WORDS`) when `Platform.Version >= 33` |
| `androidRecognitionServicePackage` | — | `createSpeechRecognizer(ctx, component)` for a named service (needs it visible under `<queries>`) |
| `maxAlternatives` | `5` | `EXTRA_MAX_RESULTS`. Always read `results[0]` |
| `volumeChangeEventOptions` | `{enabled:false}` | `onRmsChanged` → `volumechange {value}` (−2…10; < 0 inaudible), throttled by `intervalMillis` |
| `recordingOptions` | — | `{persist:true}` writes a 16 kHz mono WAV to the cache (API 33+). **Don't use it**: voice notes keep no audio |
| `audioSource` | — | Transcribe a file (API 33+). Not needed |
| `androidIntent` | `RECOGNIZE_SPEECH` | Leave it |
| `ios*` | — | Ignored on Android |

Defaults the library always sets [S]:

- `EXTRA_LANGUAGE_MODEL = free_form` (unless overridden).
- On API 34+ with `RECOGNIZE_SPEECH`: `EXTRA_REQUEST_WORD_CONFIDENCE` and `EXTRA_REQUEST_WORD_TIMING`.

### 3.3 Events (`addListener(name, fn)` / `useSpeechRecognitionEvent(name, fn)`)

| Event | Payload | When on Android [S] |
|---|---|---|
| `audiostart` | `{uri: string\|null, timestamp: number}` | Right after `startListening` |
| `start` | `null` | `onReadyForSpeech` ("speak now") |
| `speechstart` / `speechend` | `null` | `onBeginningOfSpeech` / `onEndOfSpeech` |
| `result` | `{isFinal: boolean, results: {transcript, confidence, segments}[]}` | Partials (`isFinal:false`, empty strings dropped). Finals: `onResults` (non-continuous) or `onSegmentResults` (continuous, **one per segment, covering only that segment**) |
| `nomatch` | `null` | Empty final, or `ERROR_NO_MATCH` |
| `error` | `{error: code, message, code?: number}` | Always followed by `end` (`teardownAndEnd`) |
| `volumechange` | `{value: number}` | Only if enabled |
| `languagedetection` | `{detectedLanguage, confidence, topLocaleAlternatives}` | API 34+ with on-device + `EXTRA_ENABLE_LANGUAGE_DETECTION` |
| `audioend` | `{uri, timestamp}` | During teardown |
| `end` | `null` | **Always last**, including after errors and `abort()` |

`soundstart` / `soundend` are declared but never sent on Android (the code is commented out) [S].

Error codes the Kotlin side emits [S] (`getErrorInfo`):

| Android constant (code) | `error` |
|---|---|
| `ERROR_AUDIO` (3) | `audio-capture` (also any exception in `start`) |
| `ERROR_CLIENT` (5) | `client` |
| `ERROR_INSUFFICIENT_PERMISSIONS` (9) | `service-not-allowed` |
| `ERROR_NETWORK` (2), `ERROR_NETWORK_TIMEOUT` (1), `ERROR_SERVER` (4), `ERROR_SERVER_DISCONNECTED` (11) | `network` |
| `ERROR_NO_MATCH` (7) | `no-speech`, preceded by `nomatch` |
| `ERROR_LANGUAGE_NOT_SUPPORTED` (12), `ERROR_LANGUAGE_UNAVAILABLE` (13, "supported, but not yet downloaded") | `language-not-supported`: use `code` to tell them apart |
| `ERROR_SPEECH_TIMEOUT` (6) | `speech-timeout` |
| `ERROR_RECOGNIZER_BUSY` (8) | `busy` |
| `ERROR_TOO_MANY_REQUESTS` (10) | `too-many-requests`: **missing from the TS union**, so handle unknown strings |
| other | `unknown` |
| `start()` without the permission | `not-allowed` (code −1) |
| `abort()` | `aborted` (code −1) |

### 3.4 Permissions and capability queries

| Call | Android [S][D] |
|---|---|
| `requestPermissionsAsync()` / `requestMicrophonePermissionsAsync()` | Both ask for `RECORD_AUDIO` (identical on Android). Resolve `{granted, status, canAskAgain, expires}` |
| `getPermissionsAsync()` / `getMicrophonePermissionsAsync()` | Read `RECORD_AUDIO` |
| `get/requestSpeechRecognizerPermissionsAsync()` | Android: always `granted` (no such permission) |
| `isRecognitionAvailable(): boolean` | `SpeechRecognizer.isRecognitionAvailable`. AOSP implements it as `queryIntentServices(RecognitionService)`, which is filtered by package visibility, **so it needs the plugin's `<queries>` intent** [D] |
| `supportsOnDeviceRecognition(): boolean` | API 31+: `isOnDeviceRecognitionAvailable`. AOSP only checks that the maker's `config_defaultOnDeviceSpeechRecognitionService` string names a component [D]. **True does not mean a language model is installed.** False below API 31 |
| `getSupportedLocales({androidRecognitionServicePackage?})` | API ≤ 32: `{locales:[], installedLocales:[]}`. API 33+ without a package: empty unless an on-device service exists; else `checkRecognitionSupport` on the on-device recognizer: `locales` = supported-on-device ∪ installed ∪ online, `installedLocales` = installed on device. Can reject (`error_<n>`). Add a JS timeout: if the service answers neither callback, the promise never settles |
| `androidTriggerOfflineModelDownload({locale})` | API ≤ 32: rejects `not_supported`. API 33: `{status:'opened_dialog'}` (fire and forget: re-check locales later). API 34+: `download_success` or `download_scheduled` (for example waiting for Wi-Fi), or rejects `error_<n>` |
| `getSpeechRecognitionServices(): string[]`, `getDefaultRecognitionService()`, `getAssistantService()` | Diagnostics: visible `RecognitionService` packages; `Settings.Secure` `voice_recognition_service` / `assistant` |
| `supportsRecording()` | `SDK_INT >= 33` |

---

## 4. Android behaviour

### 4.1 Which recognizer runs

- **Default:** `createSpeechRecognizer(ctx)` connects to the service named in
  `Settings.Secure.VOICE_RECOGNITION_SERVICE`, the "default user-selected speech recognizer" [D, AOSP
  comment]. If it's empty: `ERROR_CLIENT` → `client`. The README's author reports it's usually
  `com.google.android.tts` ("Speech Recognition & Synthesis from Google") on Android 13+ and
  `com.google.android.googlequicksearchbox` (the Google app) on ≤ 12 [U]. Samsung may default
  elsewhere (Bixby is mentioned as unreliable) [U].
- **On-device:** `createOnDeviceSpeechRecognizer(ctx)` uses "On-device speech recognizer which is
  determined by the manufacturer and not changeable by the user" [D]. On Pixels and many Google phones
  that is Android System Intelligence (`com.google.android.as`) [U, README; search excerpts]. Its
  models are listed in Settings → Security & privacy → More privacy settings → Android System
  Intelligence → On-device speech recognition [U, README].
- **For the spike:** log `getDefaultRecognitionService().packageName` and
  `getSpeechRecognitionServices()` on the founder's phone, to know what testers will get.

### 4.2 Continuous mode needs Android 13+; what happens on older versions

- **Android 13+ (API 33)** [S][D]:
  - `continuous: true` makes the library open the microphone itself (`AudioRecord`,
    `MediaRecorder.AudioSource.VOICE_RECOGNITION`, 16 kHz mono PCM 16-bit) and pass the pipe as
    `EXTRA_AUDIO_SOURCE`, with `EXTRA_SEGMENTED_SESSION = EXTRA_AUDIO_SOURCE`.
  - Android's documentation: "The recognition session will end when and only when the audio is closed."
  - Results come back per segment through `onSegmentResults` (a final `result` each), until `stop()`
    or `abort()` closes the pipe (then `onEndOfSegmentedSession` → `end`).
  - Side effect: **no start/stop beep** (the README's "Muting the beep" section).
  - Segmented sessions are optional for recognizers ("Depending on the recognizer implementation, this
    value may have no effect" [D]). So a recognizer that ignores it will still end after a pause, and
    the **auto-restart loop below must also run on 13+**.
  - Library quirk: each continuous start creates an empty `cache/temp_<uuid>.pcm` file that is never
    deleted (0 bytes, because nothing is written when not persisting) [S]. It's harmless; optionally
    sweep `Paths.cache` for `temp_*.pcm` when the screen closes.
- **Android ≤ 12:**
  - Don't pass `continuous: true`: its 600-second `EXTRA_SPEECH_INPUT_*` extras are "extremely rare
    you'd want to specify" and "may have no effect" [D]. The README marks continuous unsupported there.
  - Use plain sessions plus **auto-restart**: on `end`, if the person is still "recording" and the
    error (if any) is benign, call `start()` again after about 250 ms.
  - Android requires waiting for `onResults`/`onError` before `startListening` again, or the call is
    rejected [D]. Restarting on `end` satisfies that, because `end` comes after teardown.
  - Expect the **system beep at every restart** [U: hard-coded in the recognizer, per README].
  - Expect a short gap where words are lost (between `end` and the next `start`, roughly 0.3–1 s [U]).
  - This is the loop where 57.1.0 could crash on Android ≤ 11 (§1).

### 4.3 Silence timeouts and session length

- **Non-continuous** (all APIs): the recognizer's end-pointer ends the session after a pause. With no
  speech at all you get `no-speech` / `speech-timeout`. The pause length is the recognizer's choice;
  the `EXTRA_SPEECH_INPUT_*` extras are hints it may ignore [D]. The known value for Gboard-style
  recognition is about 3 s [U, third-party blog].
- **Continuous on 13+:** no silence end by design (it ends only when the pipe closes) [D]. In practice
  it depends on the service [U]. **Verify on the phone with a 10-minute run** (spike item S2, §13.3).
- **Max length:** no documented cap for either path [U]. DualRep should set its own:
  - **auto-pause after 60 s with no new partial or final result** (saves battery; Android's own warning:
    "this API is not intended to be used for continuous recognition, which would consume a significant
    amount of battery and bandwidth" [D]);
  - a **20,000-character cap per note** (the server's `STUDY_LIMITS.maxTranscriptChars`; about 20+
    minutes of speech at 150 words a minute);
  - **stop when the app leaves the foreground** (§4.7).

### 4.4 Interim and final results

- With `interimResults: true` you get `result {isFinal:false}` events whose `results[0].transcript` is
  the **current segment's** best guess so far. It keeps changing, so replace it, don't append.
- Then one `result {isFinal:true}` for that segment:
  - continuous 13+: `onSegmentResults`, then more partials for the *next* segment;
  - non-continuous: `onResults`, then teardown, `end`.
- **Model in DualRep:** `committed` (all finals joined with one space) + `live` (the latest partial).
  - On a final: `committed = join(committed, results[0].transcript)`, `live = ''`.
  - On `end` with a non-empty `live` that never became final (for example after `abort()`, or a
    service that ends without a final): commit `live` too, so no words are lost.
  - The library's example does the same tally, without the space [S], which is why `join` adds one.
- With `addsPunctuation` (API 33+), `results[0]` is the formatted hypothesis [D].
- Without it, or on the online service, expect little or no punctuation [U]. The person fixes the text
  before adding it, and Tracy's builders don't need punctuation.

### 4.5 On-device recognition: does it work offline, and how to know

- **Guaranteed on-device** only when started with `requiresOnDeviceRecognition: true` **on API 33+**
  (library → `createOnDeviceSpeechRecognizer`, "a new on-device SpeechRecognizer" [D]).
- **Probably offline:** Google describes Private Compute Core (where Android System Intelligence runs
  on-device speech, as in Live Caption) as having no direct network access; models download through
  Private Compute Services [U: search excerpts of Google's security blog and the PCC whitepaper; both
  sites blocked here]. **Prove it with airplane mode on the phone** (spike S1).
- On API 31–32, `requiresOnDeviceRecognition` only adds `EXTRA_PREFER_OFFLINE` to the *default*
  recognizer, which may ignore it [S][D]. **Treat Android ≤ 12 as "may go online".**
- **The check DualRep should run** before showing the mic (all calls exist [S]):
  1. `api >= 33 && supportsOnDeviceRecognition()`
  2. `getSupportedLocales({})` (with a 3 s timeout) → is the chosen `lang` in `installedLocales`
     (compare case-insensitively, `_` ≡ `-`)?
  3. Yes → **on-device**: label "On this phone, works offline".
  4. Not installed but in `locales` → offer **Download for offline use**
     (`androidTriggerOfflineModelDownload({locale})`): API 34+ reports success or "scheduled"; API 33
     opens a system dialog, so re-check when the app returns to the foreground. Meanwhile allow online.
  5. Else, if `isRecognitionAvailable()` → **online** (default service): label "Uses Google's speech
     service, needs the internet".
  6. Else → **unavailable** (§4.6).
- If an on-device start fails anyway with `language-not-supported` and code 13
  (`ERROR_LANGUAGE_UNAVAILABLE`), the model went missing: offer the download, or online.

### 4.6 What the user sees when no service is installed

- `isRecognitionAvailable()` is false when no app exposes `android.speech.RecognitionService` (and
  always false without the `<queries>` intent [D]).
- Starting anyway gives `client` (empty default service setting, or no manager service) or a bind error
  passed through as a code [D]. On Android ≤ 11 with 57.1.0 it could also crash (§1).
- There is **no system UI**: `SpeechRecognizer` is headless, so the app must say it. Typical phones:
  de-Googled ROMs, Huawei without Google services, emulators without Google Play images [U].
- **Recommended:** don't show the mic button. Show a Notice: "This phone has no speech-to-text service.
  Type or paste your notes, or use your keyboard's microphone." The text field stays.
- Optionally offer **Get Google's speech service**, which opens
  `market://details?id=com.google.android.tts` (on Android 13+ the README names it the default service
  [U]). This needs no `<queries>`, since `Linking.openURL` starts an activity.

### 4.7 Background, screen off, calls, permission details

- **Background:** since Android 9, an app in the background "cannot access the microphone" [D]. On 13+
  continuous it's DualRep's own `AudioRecord` that's recording, so it would record silence.
  **Stop listening on `AppState` → `background`**, keep the text, show Paused.
- **Screen off** puts the app in the background, so keep the screen awake while listening:
  `expo-keep-awake` 57.0.2 is already installed (`activateKeepAwakeAsync('dictation')` /
  `deactivateKeepAwake('dictation')`).
- **One-time permission** (Android 11+): the dialog offers *Only this time*. The app keeps access while
  visible and briefly after; the next session asks again [D]. Nothing extra to do if every mic tap
  checks `getPermissionsAsync()` first.
- **Denied twice** = permanent ("don't ask again") [D]. `canAskAgain === false` → show "Microphone
  access is off" with **Open system settings** (`Linking.openSettings()`, the same pattern as the
  camera in `add.tsx`).
- **Android 12+ shows a microphone indicator** in the status bar while any app records, and has a
  **global microphone toggle** in Quick Settings [D].
  - With 13+ continuous it is DualRep's own `AudioRecord`, so the indicator names DualRep.
  - Non-continuous: it names the recognizer's process [U].
  - What the recognizer does when the global toggle is off is untested [U]. Spike S7.
- **Phone calls / other apps recording:** concurrent-capture rules give the call priority; DualRep may
  get silence or `audio-capture` [U]. Treat it like a pause.
- **No foreground service is needed or wanted:** the mic is used only while the screen is visible.

---

## 5. Error handling that DualRep should implement

| `error` (code) | Meaning | DualRep action |
|---|---|---|
| `aborted` | We called `abort()` | Ignore |
| `no-speech` (7), `speech-timeout` (6), `nomatch` event | Pause in speech | If still recording: **restart** (counts toward the 60 s quiet timer) |
| `busy` (8), `client` (5) | Restarted too fast, or service hiccup | Restart after 300 / 600 / 1200 ms; after 3 in a row → Paused, "The speech service stopped. Tap the mic to try again." (`client` on the *first* start with `isRecognitionAvailable()` false → unavailable) |
| `network` (1/2/4/11) | Online service lost the connection | Paused: "Lost the connection to the speech service. Everything so far is kept." If an on-device model exists, offer to switch |
| `language-not-supported` (12) | Service can't do this language | Paused + language picker ("Not available in English (India) on this phone") |
| `language-not-supported` (13) | Supported, not downloaded | Offer **Download for offline use**, or online |
| `not-allowed` (−1), `service-not-allowed` (9) | Microphone permission missing | Re-check `getPermissionsAsync()`; show the permission notice |
| `audio-capture` (3 or −1) | Microphone busy, or `start()` threw (bad intent key, no on-device service) | Paused: "The microphone isn't available right now (another app may be using it)." Log `message` in dev builds |
| `too-many-requests` (10), `unknown`, anything else | — | Paused with a generic message; keep the text |

Two watchdogs:

- **After `stop()`**, if `end` hasn't arrived in 4 s, call `abort()`. A recognizer that never answers
  `stopListening` in segmented mode is a plausible hang [U].
- **Quiet timer:** 60 s since the last `result` (partial or final) while recording → `stop()` and show
  "Paused after a minute of quiet".

---

## 6. Manifest and config plugin

### 6.1 The plugin [S] (`app.plugin.js`, `createRunOncePlugin(…, "expo-speech-recognition", "56.0.1")`)

- **Options:** `microphonePermission` and `speechRecognitionPermission` are **iOS Info.plist strings
  only**. `androidSpeechServicePackages: string[]` defaults to
  `["com.google.android.googlequicksearchbox"]`, and a non-empty array **replaces** that default.
- **Android:** `AndroidConfig.Permissions.withPermissions(['android.permission.RECORD_AUDIO'])`, plus,
  per package, one `<queries>` child:
  ```xml
  <queries>
    <package android:name="com.google.android.googlequicksearchbox" />
    <intent><action android:name="android.speech.RecognitionService" /></intent>
  </queries>
  ```
  The `<intent>` is what Android documents as required for `SpeechRecognizer` when targeting API 30+
  [D]. The `<package>` entry is redundant with it but harmless: it's a package-visibility declaration
  for one named app, not `QUERY_ALL_PACKAGES`. Keep the default (don't pass
  `androidSpeechServicePackages`).
- **Library manifest:** `<manifest></manifest>`, **empty**: no permissions, no services, no receivers
  [S].
- **Not in `@expo/prebuild-config`'s `legacyExpoPlugins`**, so the plugin runs only when listed [S].
  Unlisted, the app would have neither the `<queries>` entry nor (if `RECORD_AUDIO` stayed blocked)
  the permission.

### 6.2 How `blockedPermissions` interacts

`@expo/config-plugins` `withBlockedPermissions` (run for `android.blockedPermissions`) does two things
[S, `node_modules/@expo/config-plugins/build/android/Permissions.js`]:

- It **filters every `uses-permission` of that name** and appends `tools:node="remove"`. A blocked
  `RECORD_AUDIO` therefore beats both the image picker's and the speech plugin's additions.
- It also removes the name from `config.android.permissions`.

**The line must go.** Nothing else needs to change for Android.

### 6.3 Exact change to `app.config.ts`

```diff
       'android.permission.WRITE_EXTERNAL_STORAGE',
-      // Blocked here, not with expo-image-picker's `microphonePermission: false` (which would block it
-      // from the plugin, out of sight): audio study mode (Phase 2B) unblocks it by deleting this line.
-      'android.permission.RECORD_AUDIO',
+      // RECORD_AUDIO is allowed since voice notes (speech-to-text on the phone, asked for on the first
+      // tap of the mic). It comes from expo-speech-recognition's and expo-image-picker's plugins; no
+      // foreground service comes with it (audio study mode, Phase 2B, adds those later).
       // Phase 2: never broad photo or video access ...
```
```diff
       'expo-image-picker',
       {
         photosPermission: 'DualRep opens your photos when you add pictures of your notes.',
         cameraPermission: 'DualRep uses the camera when you photograph your notes.',
+        // RECORD_AUDIO is wanted now (voice notes); the picker never asks for it (it only records
+        // video, which DualRep doesn't offer).
       },
     ],
+    [
+      // Voice notes: Android's built-in speech recognition. Adds RECORD_AUDIO and a <queries> entry
+      // for android.speech.RecognitionService (needed to find the recognizer on API 30+). No service,
+      // no foreground service, no native library. The strings are iOS-only.
+      'expo-speech-recognition',
+      {
+        microphonePermission: 'DualRep uses the microphone when you speak your notes.',
+        speechRecognitionPermission: 'DualRep turns what you say into text for your notes.',
+      },
+    ],
```

Also update the comment above `plugins` that says expo-image-picker's default `RECORD_AUDIO` "which
blockedPermissions above removes". Keep the "No expo-audio plugin yet" comment.

### 6.4 Verified result [R]

The scratch project `cfgcheck/` overlays DualRep's `node_modules` with symlinks plus a copy of the
57.1.1 package; nothing in DualRep was touched. Command:
`APP_VARIANT=preview node node_modules/expo/bin/cli config --type introspect --json`, comparing the
current config with the diff above.

| | Before (today) | After |
|---|---|---|
| `uses-permission` added (not `tools:node="remove"`) | `INTERNET`, `VIBRATE` | `INTERNET`, `VIBRATE`, **`RECORD_AUDIO`** |
| Blocked (`tools:node="remove"`) | 28 entries incl. `RECORD_AUDIO` | 27 (same minus `RECORD_AUDIO`) |
| `<queries>` | VIEW/BROWSABLE/https | same + `{package googlequicksearchbox, intent android.speech.RecognitionService}` |
| `<service>` in the app manifest | none | none |
| iOS `NSMicrophoneUsageDescription` | image picker's default | "DualRep uses the microphone when you speak your notes." |

Introspection covers what config plugins write. Library manifests are merged later by Gradle; this
library's is empty and expo-image-picker's doesn't contain `RECORD_AUDIO` [S].

**What the CI APK should then print** (`aapt2 dump permissions`): Phase 2's list
(`INTERNET`, `VIBRATE`, `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, `RECEIVE_BOOT_COMPLETED`,
`POST_NOTIFICATIONS`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, `CAMERA`) **plus `RECORD_AUDIO`**, and
still no `FOREGROUND_SERVICE*`, `MODIFY_AUDIO_SETTINGS`, `READ_MEDIA_*` or storage permissions.

Optional hardening: add an allow-list check to `.github/workflows/android.yml` after the `aapt2 dump
permissions` step. It would fail when the list differs from an `scripts/expected-permissions.txt`, so a
future library can't slip in a permission.

### 6.5 Ledger and docs updates (docs/ANDROID.md)

- **Permission ledger row `RECORD_AUDIO`:**
  - Added by: expo-speech-recognition's plugin (and expo-image-picker's plugin default).
  - Phase: voice notes.
  - Asks the user? Yes, on the first tap of the mic.
  - Play Console: nothing to declare (**verify**). Data safety: see §9.
- **Must-not-appear list:** drop `RECORD_AUDIO`. **"What the repo does today":** add the plugin and the
  `<queries>` entry.
- **2.1 / 2.4 / D42 / D49:** the "unblock `RECORD_AUDIO`" step for Phase 2B is already done. Phase 2B
  still adds expo-audio and its services.
- **2.2 (expo-audio defaults trap):** unchanged and still important.

---

## 7. 16 KB page size

`find` over the 57.1.1 package shows no `.so`, no `CMakeLists.txt`, no `.aar`/`.jar`, no C/C++ [S].
Kotlin only, with framework imports plus `androidx.annotation.RequiresApi`. `scripts/check-16kb.sh`
has nothing new to check. Nothing to do.

---

## 8. Google Play

- **Runtime prompt in context:**
  - Ask on the first tap of the mic, with a one-line explanation already on screen ("DualRep listens
    only while the mic is on").
  - Never ask at app start. Android's guidance is to request "only … when they need access to a
    specific feature", because two denials are permanent [D].
  - If refused, typing still works, and the notice offers **Open system settings**.
- **Declarations:**
  - `RECORD_AUDIO` is a normal dangerous runtime permission, believed **not** to need the Permissions
    Declaration Form (that form covers high-risk groups like SMS, Call Log, all-files access and
    package visibility) [U].
  - No foreground-service declaration: there is no service.
  - Mention microphone use in the privacy policy.
- **Data safety:** §9.

---

## 9. Data safety: is phone speech recognition "collection"?

Google's definition, from search excerpts of the Play Console FAQ [U]:

- "Collect" means **transmitting data from your app off a user's device**.
- "User data accessed by your app that is only processed locally on the user's device and not sent off
  the device" doesn't need to be disclosed.
- Data sent off the device but processed only in memory ("ephemeral") must still be declared.

| Path | Where the audio goes | Likely answer |
|---|---|---|
| **On-device** (API 33+, `createOnDeviceSpeechRecognizer`, model installed) | DualRep's process → (pipe) → the phone's on-device service. Never leaves the phone | **Audio: not collected** [U] |
| **Online fallback** (default service, e.g. Google's app) | DualRep → (on-device IPC) → Google's recognition app → Google's servers. DualRep's code and servers never send or receive audio | **Unclear** [U]. Strict reading: DualRep transmits nothing, so not collected by DualRep (the recognizer is a separate system app, not an SDK in DualRep). Conservative reading: declare **Audio → Voice or sound recordings: collected, processed ephemerally, app functionality, optional, not shared**. **Get advice**, like the open question in ANDROID.md 5.5 about Anthropic/Gemini |
| **Keyboard microphone** (Gboard etc.) | The keyboard app's business | Not DualRep's collection |
| **The transcript text** | Uploaded to DualRep and sent to Tracy/Anthropic like any material | **Collected**: App activity → Other user-generated content (already in the 5.5 draft), app functionality. Same "shared vs service provider" question as other material |

Recommendations:

- **Prefer on-device whenever it's available** (§4.5).
- **Make the online path visible:** the first time it's needed on a phone, show a one-time sheet:
  "This phone can't turn English (US) speech into text by itself. DualRep can use Google's speech
  service: what you say is sent to Google to turn it into text." Offer **Use Google's speech
  service** / **Download English for offline use** (when offered) / **Type instead**. Remember the
  choice in `study-prefs`.
- **Privacy policy line:** "When you speak your notes, your phone's speech recognition turns your voice
  into text. On phones that support it, this happens on the phone. Otherwise your phone sends the audio
  to Google's speech service. DualRep never records or stores your voice; only the text you choose to
  add is uploaded."
- **ANDROID.md 5.5:** amend the existing `Audio → voice or sound recordings` row, currently "Clips sent
  to Tracy for speech-to-text … collected if audio leaves the phone". Voice notes send no clips to
  Tracy.

---

## 10. The zero-code fallback: the keyboard's microphone

- **How it behaves** [U, from general knowledge and forum/blog excerpts; Google's Gboard help pages
  were unreachable]:
  - Any focused `TextInput` (DualRep's `TextField`, `multiline`) shows the keyboard. Gboard has a mic
    key in its toolbar; Samsung Keyboard (the default on Samsung phones) has its own voice input.
  - Dictated text is inserted at the cursor, with the keyboard's own interim underline.
  - It usually stops after a pause of a few seconds, and you tap the mic again.
  - Online or offline depends on the keyboard: Gboard's offline or "faster voice typing" has existed
    mainly for some languages on some (Pixel) phones.
  - Voice commands like "period" or "comma" and auto-punctuation vary.
- **What DualRep needs:** nothing.
  - No permission: the keyboard app holds `RECORD_AUDIO`. No manifest change, no library.
  - Field settings: `autoCorrect` and the default `keyboardType` (not `visible-password`, which hides
    voice and suggestions on some keyboards [U]), `autoCapitalize="sentences"`,
    `textAlignVertical="top"`.
- **Offer it alongside, not instead.** The text field is needed anyway (fixing mistakes, typing,
  pasting), so the keyboard mic comes free. Add a hint under the field: "Tip: your keyboard's
  microphone works here too."
- **But it isn't enough on its own:**
  - DualRep can't show online versus on-device, pick the language, auto-continue after pauses, or show
    a big target.
  - Some keyboards don't offer dictation.
  - It's also the **only** path on phones with no recognition service (§4.6), which is why the field
    must always be there.
- **Order:** the plain text field (typed and pasted notes, keyboard mic) is trivial and can land first,
  even before the speech library. The in-app mic is a layer on the same field.

---

## 11. Recommended screen behaviour

**Where:** a fourth segment on **Add material** (`/plans/[id]/add`). The four segments are `File` |
`Photos` | `Link` | **`Voice`**: mode value `'text'`, accessibility label "Speak or type your notes"
(the alternative label is "Text"). Check the four labels fit at 320 dp. The mode value is not
`'notes'`, because `notes` already means photos of handwritten notes (the `SourceKind` and
`kindOfProgress`). The footer stays **Add to plan**, the one primary action (D48). The dictation UI
is a component in `src/features/study/ui/`.

**Layout, top to bottom:**

1. Notices, if relevant: offline (existing `OfflineNotice`: adding needs the internet), and the
   single-source plan notice.
2. **Recognition line** (one short `Text`, tone secondary, plus an action):
   - on-device: "Speech is turned into text on this phone. Works offline."
   - online: "Uses Google's speech service: what you say is sent to Google to turn it into text. Needs
     the internet." With a **Download English (US) for offline use** link when offered.
   - unavailable: Notice "This phone has no speech-to-text service. Type or paste your notes, or use
     your keyboard's microphone."
3. **Language:** a chip "English (US) · Change".
   - Default: the phone's locale, read in JS (`Intl.DateTimeFormat().resolvedOptions().locale` on
     Hermes, giving a BCP 47 tag like `en-GB` [U: check on the phone]). Don't pass `lang: ''`, which
     sends `en_US` (§3.2).
   - The picker lists English variants first (`en-US`, `en-GB`, `en-AU`, `en-CA`, `en-IN`, `en-IE`,
     `en-NZ`, `en-ZA`), then the phone's locale if not English, then (API 33+) other entries of
     `getSupportedLocales().locales` with "(beta)".
   - Each entry is marked "offline" when in `installedLocales`. The choice is saved per phone in
     `study-prefs`.
4. **The mic button:** about 96 dp circle, centred, haptic on tap.
   - Idle "Tap to talk" → Listening (pulsing ring scaled by `volumechange`; label "Listening… tap to
     pause") → Paused ("Paused. Tap to continue.").
   - Accessibility: role button, label "Start dictation" / "Pause dictation", live region for state
     changes.
5. **Transcript:**
   - A multiline `TextField` holding `committed` text. It is **read-only while listening** (so a
     cursor and incoming text never fight) and auto-scrolls to the end. When paused it's **editable**,
     and new speech appends at the end of whatever is in the field.
   - Under it, while listening, the `live` partial in secondary tone ("…the Krebs cycle produces"),
     not part of the value.
   - A character counter that appears after 15,000 ("18,240 of 20,000").
   - Hint: "Check the words before adding. Tip: your keyboard's microphone works here too."
6. **Secondary buttons:** **Clear** (asks first). **Stop** is the same as Pause: one button, no
   separate "done".
7. **Name (optional)** field (existing), placeholder `notesTitle(now)` → "Notes, 12 Oct".

**Rules:**

- **Permission:** see §8. Never prompt before the first mic tap.
- **Auto-restart:** while the person's intent is "recording" (they tapped the mic and haven't paused),
  every `end` that isn't fatal restarts recognition. That is needed on Android ≤ 12, and a safety net
  on 13+ continuous. Capped by the backoff in §5.
- **Auto-pause:** 60 s with no new words; app leaves the foreground; the 20,000-character cap ("That's
  the most one note can hold. Add it to the plan, then start another."); fatal errors (§5).
- **Max length:**
  - 20,000 characters (= `maxTranscriptChars`).
  - Dictation stops at the cap.
  - Typing and pasting: don't set `maxLength` (it truncates pastes silently); instead turn the counter
    red and block **Add to plan** with "Shorten it to 20,000 characters or split it into two notes".
  - Minimum: about 100 characters ("Say or type a bit more first. A sentence or two makes at least one
    card.") [suggestion; the server track sets the real rule].
- **Add to plan while listening:** `stop()`, wait for `end` (4 s watchdog → `abort()` + commit
  `live`), then submit the field's text.
- **Never lose words:**
  - Save the draft (`{text, title, lang, updatedAt}`) to `local_state` key
    `study-note-draft:<planId>`, debounced 1 s and on every pause or blur.
  - Restore it when the screen opens; delete it after a successful add.
  - `local_state` is local-only, so the draft never syncs.
- **Keep the screen on** only while listening.
- **No audio is kept:** never pass `recordingOptions.persist`.
- **What the app does with the words:** nothing until **Add to plan**. Then the text goes through
  `addMaterial` like other material. The server track decides the kind (`text`) and whether it's
  inline or a `.txt` object. The text is already confirmed by the person, so no transcription-review
  step: straight to outline.

---

## 12. File-by-file changes (phone side)

| File | Change |
|---|---|
| `package.json` | `"expo-speech-recognition": "57.1.1"` (exact) |
| `app.config.ts` | §6.3: delete the `RECORD_AUDIO` block line, add the plugin entry, fix two comments |
| `src/features/study/dictation.ts` (**new**, pure, no native import) | `pickEngine()`, `startOptions()`, `joinSegment()`, `classifyError()`, `localeMatches()`, `defaultDictationLang()`, `DICTATION_LIMITS` |
| `src/features/study/useDictation.ts` (**new**) | The hook: listeners via `ExpoSpeechRecognitionModule.addListener`, permission flow, engine probe, restart loop, watchdogs, `AppState`, keep-awake, draft autosave |
| `src/features/study/ui/DictationPanel.tsx` (**new**) | Mic button, recognition line, language chip/picker, transcript field + live line, counter, notices |
| `src/app/(app)/plans/[id]/add.tsx` | `Mode` gains `'text'` (label `Voice`, accessibility label "Speak or type your notes"); render `DictationPanel`; `submit()` validates and calls `addMaterial(context, {kind: 'text', text, title}, …)`; source id kept in `ids.text` like photos and links; `kindOfProgress` gains `'text'` |
| `src/features/study/upload.ts` | `MaterialInput` gains `{ kind: 'text'; text: string; title?: string \| null }`; `validateText(text)` (trim, min, ≤ 20,000); default title `notesTitle(now)`; the request shape per the server track's contract (inline text, or an uploaded `1.txt`) |
| `src/features/study/studyApi.ts` | `SourceKind` gains `'text'` and `KIND_FILE_TYPES.text` (if it's a file) — mirrors `_shared/contracts.ts` (server track) |
| `src/features/study/studyPrefs.ts` | `StudyPrefs` gains `dictationLang: string \| null` (null = phone locale) and `dictationOnline: 'ask' \| 'allowed'`; `applyPrefsPatch` validation (BCP 47 regex, enum) |
| `src/components/…` (`materialProgressText`) | Wording for `'text'` ("Sending your notes…") |
| `src/features/study/sourceProgress.ts` | A text source skips "Check the transcription" (server track decides; the phone only reads synced status) |
| Tests | `__tests__/dictation.test.ts` (pure), `__tests__/useDictation.test.tsx` (emitter mock, §13), `components/__tests__/studyScreens.test.tsx` (Voice mode: unavailable, permission-off, add flow) |
| `docs/ANDROID.md` | Ledger row, Phase 2 permission list (+`RECORD_AUDIO`), must-not-appear list, 2.1/2.4 notes, 5.5 Data safety rows (§9) |
| `docs/DECISIONS.md` | D50 "Voice notes: speech-to-text on the phone" (library and version, `RECORD_AUDIO` unblocked, on-device first, online fallback with notice, no audio kept, 20,000 cap, keyboard mic alongside) |
| `docs/SETUP.md` | Phone checks for voice notes (§13.3) |
| `docs/ROADMAP.md` | The feature's line, and Phase 2B's "unblock `RECORD_AUDIO`" item marked done |

### 12.1 `dictation.ts` (sketch)

```ts
import type { ExpoSpeechRecognitionErrorEvent, ExpoSpeechRecognitionOptions } from 'expo-speech-recognition';

export const DICTATION_LIMITS = {
  maxChars: 20_000,          // = STUDY_API_LIMITS.maxTranscriptChars
  minChars: 100,
  quietPauseMs: 60_000,
  stopWatchdogMs: 4_000,
  restartDelayMs: 250,
  retryDelaysMs: [300, 600, 1200] as const,
} as const;

export type Engine =
  | { kind: 'on-device'; canDownload: false }
  | { kind: 'online'; canDownload: boolean }   // canDownload: an offline model exists for lang
  | { kind: 'download-only' }                  // on-device service knows lang, no online service
  | { kind: 'unavailable' };

const norm = (tag: string) => tag.trim().replace(/_/g, '-').toLowerCase();
export const localeMatches = (list: readonly string[], lang: string) => list.some((t) => norm(t) === norm(lang));

export function pickEngine(p: {
  api: number; recognitionAvailable: boolean; onDeviceService: boolean;
  installed: readonly string[]; supported: readonly string[]; lang: string;
}): Engine {
  const onDeviceReady = p.api >= 33 && p.onDeviceService && localeMatches(p.installed, p.lang);
  if (onDeviceReady) return { kind: 'on-device', canDownload: false };
  const downloadable = p.api >= 33 && p.onDeviceService && localeMatches(p.supported, p.lang);
  if (p.recognitionAvailable) return { kind: 'online', canDownload: downloadable };
  return downloadable ? { kind: 'download-only' } : { kind: 'unavailable' };
}

export function startOptions(engine: 'on-device' | 'online', lang: string, api: number, terms: readonly string[] = []):
  ExpoSpeechRecognitionOptions {
  return {
    lang,                                   // always a BCP 47 tag, never ''
    interimResults: true,
    continuous: api >= 33,                  // ≤ 12: plain sessions + auto-restart
    requiresOnDeviceRecognition: engine === 'on-device',
    addsPunctuation: api >= 33,
    androidIntentOptions: {
      EXTRA_LANGUAGE_MODEL: 'free_form',    // exists since API 3
      // API-33+ keys only on 33+: unknown fields make start() fail (reflection, §3.2).
      ...(api >= 33 ? { EXTRA_MASK_OFFENSIVE_WORDS: false } : {}), // notes are the person's own words
    },
    ...(api >= 33 && terms.length > 0 ? { contextualStrings: terms.slice(0, 50) } : {}),
    volumeChangeEventOptions: { enabled: true, intervalMillis: 150 },
  };
}

/** Appends a final segment with one space; leaves the person's edits alone. */
export function joinSegment(committed: string, segment: string): string {
  const s = segment.replace(/\s+/g, ' ').trim();
  if (!s) return committed;
  if (committed.length === 0 || /\s$/.test(committed)) return committed + s;
  return `${committed} ${s}`;
}

export type ErrorAction = 'ignore' | 'restart' | 'retry' | 'permission' | 'network' | 'language' | 'download' | 'busy-mic' | 'stop';
export function classifyError(e: Pick<ExpoSpeechRecognitionErrorEvent, 'error' | 'code'>): ErrorAction {
  switch (e.error as string) {
    case 'aborted': return 'ignore';
    case 'no-speech': case 'speech-timeout': return 'restart';
    case 'busy': case 'client': return 'retry';
    case 'not-allowed': case 'service-not-allowed': return 'permission';
    case 'network': return 'network';
    case 'language-not-supported': return e.code === 13 ? 'download' : 'language';
    case 'audio-capture': return 'busy-mic';
    default: return 'stop';  // includes 'too-many-requests', 'unknown'
  }
}
```

`terms` (optional): the plan's topic titles, to bias recognition toward course vocabulary (API 33+).
The effect is unverified; leave it out if the spike shows nothing.

### 12.2 `useDictation.ts` (sketch of the core loop)

```ts
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { AppState, Platform } from 'react-native';

const API = typeof Platform.Version === 'number' ? Platform.Version : 0;
type Status = 'idle' | 'starting' | 'listening' | 'stopping' | 'paused';

// refs: wantListening, lastHeardAt, retries, stopTimer, quietTimer, engineRef, textRef
useEffect(() => {
  const subs = [
    ExpoSpeechRecognitionModule.addListener('start', () => setStatus('listening')),
    ExpoSpeechRecognitionModule.addListener('result', (e) => {
      lastHeardAt.current = Date.now(); retries.current = 0;
      const t = e.results[0]?.transcript ?? '';
      if (e.isFinal) { commit(t); setLive(''); } else setLive(t);
    }),
    ExpoSpeechRecognitionModule.addListener('volumechange', (e) => setLevel(e.value)),
    ExpoSpeechRecognitionModule.addListener('error', (e) => { lastError.current = classifyError(e); }),
    ExpoSpeechRecognitionModule.addListener('end', () => {
      clearTimeout(stopTimer.current);
      if (liveRef.current) { commit(liveRef.current); setLive(''); }  // never lose words
      const action = lastError.current; lastError.current = null;
      const benign = action === null || action === 'restart' || action === 'ignore' || action === 'retry';
      if (wantListening.current && benign && textRef.current.length < DICTATION_LIMITS.maxChars) {
        const delay = action === 'retry' ? DICTATION_LIMITS.retryDelaysMs[retries.current++] : DICTATION_LIMITS.restartDelayMs;
        if (delay === undefined) return pause('service');                   // 3 retries used
        restartTimer.current = setTimeout(() => wantListening.current && begin(), delay);
      } else {
        pause(action ?? 'done');
      }
    }),
  ];
  return () => { subs.forEach((s) => s.remove()); ExpoSpeechRecognitionModule.abort(); };
}, []);

// begin(): ExpoSpeechRecognitionModule.start(startOptions(engine, lang, API, terms)); setStatus('starting');
// pauseByUser(): wantListening=false; ExpoSpeechRecognitionModule.stop(); stopTimer = setTimeout(() => ExpoSpeechRecognitionModule.abort(), 4000);
// quiet timer: every 5 s, if wantListening && Date.now() - lastHeardAt > 60_000 → pauseByUser() with reason 'quiet'
// AppState 'background' → pauseByUser(); keep-awake on while status is 'starting' | 'listening'
```

Note: `abort()` emits `error aborted` before `end`, and that maps to `ignore`. Don't let it count as a
failure.

---

## 13. Testing

### 13.1 Jest (verified [R])

DualRep's preset is `jest-expo` 57.0.5. Its `requireNativeModule` mock looks for
`<package>/mocks/<ModuleName>`. expo-speech-recognition ships no `mocks/`, so a bare import **throws**.
This was confirmed in `jestcheck/unmocked.test.js`, run with DualRep's own jest and
`node_modules`:

```
Cannot find native module 'ExpoSpeechRecognition'
```

Any test that imports a file which imports the library needs `jest.mock('expo-speech-recognition',
…)`. This hand-written emitter mock **passed** in `jestcheck/mocked.test.js`: a component subscribed
through `addListener`, rendered the emitted partial, and removed its listener on unmount.

```ts
jest.mock('expo-speech-recognition', () => {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const ExpoSpeechRecognitionModule = {
    start: jest.fn(), stop: jest.fn(), abort: jest.fn(),
    requestPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted', canAskAgain: true, expires: 'never' })),
    getPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted', canAskAgain: true, expires: 'never' })),
    isRecognitionAvailable: jest.fn(() => true),
    supportsOnDeviceRecognition: jest.fn(() => true),
    getSupportedLocales: jest.fn(async () => ({ locales: ['en-US', 'en-GB'], installedLocales: ['en-US'] })),
    androidTriggerOfflineModelDownload: jest.fn(async () => ({ status: 'download_success', message: '' })),
    getDefaultRecognitionService: jest.fn(() => ({ packageName: 'com.google.android.tts' })),
    addListener: jest.fn((name: string, fn: (e: unknown) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
      return { remove: () => listeners.get(name)!.delete(fn) };
    }),
  };
  return {
    ExpoSpeechRecognitionModule,
    __emit: (name: string, payload: unknown) => listeners.get(name)?.forEach((fn) => fn(payload)),
  };
});
// in a test: const { __emit } = jest.requireMock('expo-speech-recognition') as { __emit: (n: string, p: unknown) => void };
// await act(async () => { __emit('result', { isFinal: true, results: [{ transcript: 'cells divide', confidence: 0.9, segments: [] }] }); __emit('end', null); });
```

- **Why `addListener`, not the library's `useSpeechRecognitionEvent`:** the mock stays tiny, and the
  hook is just `useEventListener` around `addListener` anyway [S].
- **Also mock** `expo-keep-awake` (already done in two DualRep test files) and set `Platform.Version`
  where the API level matters: `jest.replaceProperty(Platform, 'Version', 32)`.
- **Pure tests for `dictation.ts`:**
  - `pickEngine` over the API, service and locale matrix (on-device installed / downloadable / online /
    unavailable, `en_US` vs `en-us`);
  - `startOptions` (`continuous` and API-33-only keys absent at 32; `requiresOnDeviceRecognition` only
    for on-device);
  - `joinSegment` (spacing, edits kept);
  - `classifyError` (each code, 12 vs 13, unknown strings).
- **Hook tests:**
  - restart after `no-speech` + `end` while recording; no restart after a user pause;
  - 3 `busy` retries, then Paused;
  - `live` committed on `end`; the 60 s quiet pause (fake timers); the 4 s stop watchdog calls `abort`;
  - `AppState` background pauses; the cap stops dictation;
  - permission denied with `canAskAgain:false` shows the settings notice.

### 13.2 The experiment, for reproduction

- `jestcheck/jest.config.js` uses `preset: 'jest-expo'`, `modulePaths: ['/home/user/DualRep/node_modules']`
  and `moduleNameMapper` pointing `expo-speech-recognition` at the unpacked 57.1.1 `build/index.js`.
- Run with `node /home/user/DualRep/node_modules/jest/bin/jest.js --config jest.config.js`.
- Result: 2 suites, 2 tests passed. Nothing was written inside DualRep.

### 13.3 On the phone (spike before building the UI; about half a day)

| # | Check | Pass when |
|---|---|---|
| S1 | Android 13+ phone: `supportsOnDeviceRecognition()`, `getSupportedLocales({})`, `getDefaultRecognitionService()`; download `en-US` if needed; **airplane mode**, dictate with `requiresOnDeviceRecognition:true` | Text appears offline; the line says "On this phone" |
| S2 | Android 13+: `continuous:true`, talk with long pauses for 10 min, both on-device and online | One session; finals per segment; no `end` until Pause (else the restart loop covers it) |
| S3 | Android ≤ 12 (emulator API 30/31 with a Google Play image, or an old phone): restart loop | No crash (57.1.1); beep per restart; words keep coming |
| S4 | Emulator image without Google services, or the Google app disabled | `isRecognitionAvailable()` false → typing-only notice; no crash on API 30 |
| S5 | Deny once, deny twice, *Only this time* | Notices and **Open system settings** behave; typing still works |
| S6 | Lock the screen or switch apps mid-dictation; incoming call | Pauses, text kept; keep-awake prevents dimming while listening |
| S7 | Android 12+ global microphone toggle off | Record what happens (system dialog or `audio-capture`); show a sensible notice |
| S8 | `addsPunctuation` on-device vs online; `EXTRA_MASK_OFFENSIVE_WORDS:false` | Note the quality; keep or drop the options |
| S9 | CI APK: `aapt2 dump permissions`; 16 KB check | `+RECORD_AUDIO` only; 16 KB OK |
| S10 | Gboard and Samsung Keyboard mic in the text field | Dictation inserts text; nothing else needed |

Emulator tip: microphone input needs **Extended controls → Microphone → "Virtual microphone uses host
audio input"** [U].

---

## 14. Open questions and unverified points

1. **Play Data safety for the online fallback** (§9) and the exact wording of Google's
   collection definition: support.google.com was unreachable. Get advice; same channel as ANDROID.md
   5.5's Anthropic/Gemini question.
2. **No Permissions Declaration Form for `RECORD_AUDIO`:** believed so, not read in Google's page.
3. **Default recognizer per maker** (Google `tts` vs the Google app vs Samsung) and **on-device
   availability on Samsung**: phone check S1.
4. **Continuous segmented sessions on the online Google service**, and any hidden session limit: S2.
5. **Private Compute Core has no network access:** search excerpts only; airplane-mode test S1 is
   the real proof.
6. **Gboard/Samsung Keyboard voice behaviour** (pause length, offline, punctuation): S10.
7. **Native compile on SDK 57:** CI build (the library's example app is still SDK 56).
8. **Hermes `Intl` locale string** for the default language: log it on the phone.

---

## 15. Sources

- npm: `npm view expo-speech-recognition time|dist|_npmUser`; tarballs 57.0.0, 57.1.0, 57.1.1 in
  `scratch/esr-*` (README, `android/src/main/**`, `app.plugin.js`, `src/*.ts`, `build/*.js`).
- GitHub (git clone, read-only): https://github.com/jamsch/expo-speech-recognition at `8b31e39`:
  `CHANGELOG.md`, commit `cf5e435` (#182), `05b9ab0` ("feat: expo 57"), `example/App.tsx`,
  `example/package.json`.
- Android reference: https://developer.android.com/reference/android/speech/SpeechRecognizer ·
  https://developer.android.com/reference/android/speech/RecognizerIntent
- AOSP source (GitHub mirror):
  https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/android11-release/core/java/android/speech/SpeechRecognizer.java ·
  https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/core/java/android/speech/SpeechRecognizerImpl.java ·
  https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/core/java/android/speech/SpeechRecognizer.java
- Android guides: https://developer.android.com/training/permissions/requesting (one-time
  permissions, permanent denial) · https://developer.android.com/about/versions/pie/android-9.0-changes-all
  (background apps can't access the microphone) ·
  https://developer.android.com/about/versions/12/behavior-changes-all (microphone toggle and
  indicator)
- DualRep: `app.config.ts`, `package.json`, `docs/ANDROID.md` (ledger, 0.4, 0.7, 2.1–2.7, 5.5),
  `docs/DECISIONS.md` D31–D49, `docs/DATA_MODEL.md` "The study pipeline",
  `docs/research/phase2/expo.md`, `src/app/(app)/plans/[id]/add.tsx`, `src/features/study/upload.ts`,
  `studyApi.ts`, `studyPrefs.ts`, `supabase/functions/_shared/contracts.ts`,
  `node_modules/@expo/config-plugins/build/android/Permissions.js`,
  `node_modules/@expo/prebuild-config/build/plugins/withDefaultPlugins.js`,
  `node_modules/jest-expo/src/preset/setup.js`, `node_modules/expo-image-picker/…/ImagePickerModule.kt`.
- tracy-ai (precedent): `MOBILE.md` and `web/native/bridge.js` already use Android `SpeechRecognizer`
  through `@capacitor-community/speech-recognition` with `RECORD_AUDIO`.
- Search excerpts only [U]: Google Play Data safety FAQ (goo.gle/faqs, via
  https://appmetrica.yandex.com/docs/en/data-security/google-data-safety); Private Compute Core
  (https://9to5google.com/2021/09/09/android-private-compute-services/,
  https://ar5iv.labs.arxiv.org/html/2209.10317); Gboard offline voice typing
  (https://www.androidauthority.com/google-gboard-ai-dictation-965083/,
  https://discuss.grapheneos.org/d/1487-gboard-doesnt-download-offline-voices/1); Gboard pause timeout
  (https://www.yaps.ai/blog/gboard-voice-typing-keeps-stopping.md); Play permissions declaration
  (https://support.google.com/googleplay/android-developer/answer/9214102).
