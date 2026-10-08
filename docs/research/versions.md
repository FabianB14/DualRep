# DualRep Phase 0: pinned, cross-checked package versions (research report)

> Research date: 2026-10-08. Reference copy of a Phase 0 research report, kept as background. Where it disagrees with the repo (migration, sync config, code) or with the guides in `docs/`, the repo and the guides win.

## Summary
- **Use Expo SDK 57**: `expo@57.0.27`, `latest` tag, SDK released 2026-06-30. It ships React Native 0.86.3 and React 19.2.3. SDK 58 is still beta (`next` = 58.0.6, published 2026-09-29), so don't use it yet.
- **The New Architecture is mandatory and can't be turned off.** RN 0.86's Gradle plugin hard-codes `isNewArchEnabled() = true` and forces `newArchEnabled=true` on every subproject. Setting it to `false` only logs "not supported anymore since React Native 0.82". The SDK 57 config types have no `newArchEnabled` field.
- **Android defaults:** minSdk **24**, compileSdk **36**, targetSdk **36**, buildTools 36.0.0, NDK 27.1.12297006, CMake 3.30.5, AGP 8.12.0, Kotlin 2.1.20, Gradle wrapper 9.3.1. You need a **JDK 17** toolchain.
- **Node:** `^20.19.4 || ^22.13.0 || ^24.3.0` (from react-native and metro). supabase-js requires Node `>=22`, so use **Node 22.13+ or 24 LTS**. The research environment ran Node 22.22.0 with no problems.
- **PowerSync changed a lot in 2.x.** Install `@powersync/react-native@2.3.1` plus `@op-engineering/op-sqlite@18.2.5` and nothing else for the database:
  - Quick SQLite support is gone.
  - Do **not** install `@powersync/op-sqlite`. It is stuck on `@powersync/common@1.57.3`.
  - `@powersync/attachments` is deprecated; attachments are now built into the SDK.
  - The old fetch and stream polyfills are no longer needed (it uses `expo/fetch`).
  - No config plugin and no Metro changes are needed.
- **What I ran:** a real `create-expo-app` probe with `expo install`, typecheck, an Android Hermes bundle export, `expo lint`, Jest, `expo-doctor` (19/21 passed; the 2 failures are network checks that could not reach their hosts) and `expo prebuild --platform android`. Everything passed. **I could not run a native Gradle build here**, so the first `expo run:android` or EAS dev build is still unverified.

## 1. Version pins
Expo SDK packages come from `expo@57.0.27/bundledNativeModules.json`, resolved to the highest version that fits each range. The probe installed exactly these.

| Package | SDK range | Exact pin | Note |
|---|---|---|---|
| expo | — | **57.0.27** | |
| react / react-dom | 19.2.3 | **19.2.3** | react-dom only if you want web |
| react-native | 0.86.3 | **0.86.3** | npm `latest` is 0.87.1, but SDK 57 needs 0.86 |
| expo-router | ~57.0.25 | **57.0.25** | |
| expo-dev-client | ~57.0.19 | **57.0.19** | |
| expo-secure-store | ~57.0.4 | **57.0.4** | |
| expo-crypto | ~57.0.3 | **57.0.3** | |
| expo-constants | ~57.0.21 | **57.0.21** | |
| expo-linking | ~57.0.12 | **57.0.12** | |
| expo-status-bar | ~57.0.1 | **57.0.1** | |
| expo-splash-screen | ~57.0.9 | **57.0.9** | |
| expo-system-ui | ~57.0.4 | **57.0.4** | |
| expo-font | ~57.0.4 | **57.0.4** | |
| expo-haptics | ~57.0.3 | **57.0.3** | |
| expo-notifications | ~57.0.22 | **57.0.22** | |
| expo-build-properties | ~57.0.22 | **57.0.22** | |
| expo-sqlite | ~57.0.4 | 57.0.4 | **Leave it out**: it would be a second SQLite engine next to op-sqlite |
| react-native-reanimated | 4.5.1 | **4.5.1** | peers: RN `0.83-0.86`, worklets `0.10.x` |
| react-native-worklets | 0.10.1 | **0.10.1** | **Required** by Reanimated 4, and `expo-modules-core` also needs it (`^0.7.4…^0.10.0`) |
| react-native-gesture-handler | ~2.32.0 | **2.32.0** | npm latest is 3.3.0; don't use it |
| react-native-safe-area-context | ~5.7.0 | **5.7.0** | |
| react-native-screens | ~4.26.0 | **4.26.2** | |
| @shopify/react-native-skia | 2.6.2 | **2.6.2** | npm latest is 2.14.0; don't use it. Wait to install until a screen needs it (adds a lot to APK size) |
| @react-native-async-storage/async-storage | 2.2.0 | **2.2.0** | npm latest is 3.1.1; don't use it |
| @react-native-community/netinfo | 12.0.1 | 12.0.1 | optional |
| react-native-get-random-values | ~1.11.0 | 1.11.0 | only needed if you use the `uuid` package |
| jest-expo | ~57.0.5 | **57.0.5** | peers on `@react-native/jest-preset ^0.86.3` (npm installed 0.86.3 automatically) |
| eslint-config-expo | ~57.0.2 | **57.0.2** | |
| eslint | — | **9.39.5** | `expo lint` requires `eslint@^9.0.0`. ESLint 10.12.0 is out and npm marks 9.x deprecated, but stay on 9 |
| typescript | ~6.0.3 (template) | **6.0.3** | npm latest is 7.0.2 (the Go rewrite); not tested |
| @types/react | ~19.2.2 (template) | **19.2.18** | |
| @powersync/react-native | — | **2.3.1** | published 2026-10-01; depends on common 2.3.1, react 2.0.2, shared-internals 1.3.1 |
| @op-engineering/op-sqlite | — | **18.2.5** | PowerSync peer range is `>=17.1.0 <19.0.0` |
| @supabase/supabase-js | — | **2.117.3** | published 2026-10-07; engines node `>=22` |
| ts-fsrs | — | **5.4.2** | published 2026-09-01; no dependencies; ships both CJS and ESM |
| @azure/core-asynciterator-polyfill | — | **1.0.2** | cheap safeguard, see section 3 |

Don't move the SDK-managed packages to their npm `latest` versions. For example, reanimated 4.7.1 needs worklets 0.13.x, which breaks `expo-modules-core`'s worklets peer range.

## 2. Platform facts and how I found them
- **Android SDK levels.** The `expo-root-project` plugin (in `expo-modules-autolinking@57.0.14`, file `ExpoRootProjectPlugin.kt`) fills `rootProject.ext` from an `expoLibs` version catalog. `settings.gradle` sets that up with `useExpoVersionCatalog()`, which reads `react-native/gradle/libs.versions.toml`. That file says: `minSdk = "24"`, `targetSdk = "36"`, `compileSdk = "36"`, `buildTools = "36.0.0"`, `ndkVersion = "27.1.12297006"`, `agp = "8.12.0"`, `kotlin = "2.1.20"`.
  - You can override any of these with `expo-build-properties` or with `android.minSdkVersion`-style gradle properties.
  - The prebuilt `android/app/build.gradle` uses `rootProject.ext.minSdkVersion/compileSdkVersion/targetSdkVersion`. `android/gradle.properties` has `newArchEnabled=true`, `hermesEnabled=true`, `edgeToEdgeEnabled=true`.
  - The Gradle wrapper is `gradle-9.3.1-bin.zip`.
- **Play Store.** targetSdk 36 meets Google Play's rule: since 2026-08-31, new apps and updates must target API 36. The expo-doctor "meets version requirements for submission to app stores" check passed.
- **Android 16 side effects.** With target API 36, edge-to-edge can't be turned off, and screens 600dp or wider ignore orientation locks. The template's `"orientation": "portrait"` won't hold on tablets and foldables.
- **JDK.** The RN Gradle plugin declares `jvmToolchain(17)`. My Gradle run with only JDK 21 installed failed: "Cannot find a Java installation … matching languageVersion=17" (foojay auto-download was not available). On a dev machine, install JDK 17 or let foojay fetch it.
- **Local Android build needs:** JDK 17, Android SDK Platform 36, Build-Tools 36.0.0, NDK 27.1.12297006, CMake 3.30.5. Then run `npx expo run:android` or `eas build --profile development --platform android`.

## 3. PowerSync (React Native 2.x)
**Install:** `npx expo install @powersync/react-native @op-engineering/op-sqlite`. This is the command in the 2.3.1 README.

**Which SQLite adapter**
- OP-SQLite is now the only native adapter, and it's built into `@powersync/react-native`. The 2.0.0 changelog says: "Remove support for React Native Quick SQLite", OPSqliteOpenFactory "is now the default and part of the @powersync/react-native package", and "drop dependencies on @powersync/op-sqlite".
- `@powersync/op-sqlite@0.9.16` (last release 2026-08-04) depends on `@powersync/common@1.57.3`, which doesn't match 2.x.
- A docs snippet found by search still shows `npx expo install @powersync/op-sqlite …`. That page is out of date; ignore it.

**New Architecture**
- op-sqlite 18 is a codegen TurboModule (`codegenConfig: OPSQLiteSpec`).
- PowerSync's own small Android helper (`NativePowerSyncHelper`) is an old-style `ReactContextBaseJavaModule`, reached through `NativeModules`. It should run through RN's interop layer, but I haven't confirmed that on a device.
- PowerSync's Android module pulls `com.powersync:powersync-sqlite-core:0.5.3` from Maven Central and loads `libpowersync` / `sqlite3_powersync_init` automatically. You don't configure anything.

**Config plugin:** none for PowerSync or op-sqlite (neither has an `app.plugin.js`). op-sqlite's options, such as `"op-sqlite": {"sqlcipher": true}` or `{"fts5": true}`, go in a key in `package.json`.

**Polyfills and Babel**
- The 2.0.0 release removed the TextEncoder, react-native-fetch-api and ReadableStream polyfills. The SDK now uses `require('expo/fetch')` for streaming HTTP.
- `@azure/core-asynciterator-polyfill`: the README still recommends it for watch queries and `getCrudTransactions()` that use the AsyncIterator style. The SDK has its own `Symbol.asyncIterator ?? Symbol.for('Symbol.asyncIterator')` shim, which matches that polyfill.
  - **Recommendation:** add the polyfill as the first import in `src/app/_layout.tsx`. It's cheap insurance, because I couldn't check whether Hermes provides `Symbol.asyncIterator`.
  - In app code, prefer the callback-style `watch` or the `useQuery` hooks, and `getNextCrudTransaction()`.
- `@babel/plugin-transform-async-generator-functions`: **you don't need to add it.** `babel-preset-expo@57.0.14` already includes it in both its hermes-v0 and hermes-v1 profiles. The preset also adds the `react-native-worklets/plugin` babel plugin automatically.

**Metro:** no changes. Expo's default config has `inlineRequires: false` (I confirmed this from `getDefaultConfig`) and has `unstable_enablePackageExports: true`. The README's `inlineRequires.blockList` workaround is only for bare React Native.

**@powersync/react:** comes in as a dependency (2.0.2) and its hooks are re-exported from `@powersync/react-native` (`useQuery`, `PowerSyncContext`, …). Don't install it separately.

**Attachments:** `@powersync/attachments@3.0.0` is deprecated ("Attachment support is now built into the PowerSync SDKs"). `AttachmentQueue` and its adapters ship in `@powersync/common` 2.x. You don't need either for Phase 0.

**Expo Go:** not supported with op-sqlite. `@powersync/adapter-sql-js@0.0.25` exists for Expo Go, but it's an alpha and its README says it is for development only: it rewrites the whole database file on every write and makes no consistency guarantees. Use dev builds.

**API renames in 2.0:**
- `AbstractPowerSyncDatabase` is now `CommonPowerSyncDatabase`. The old name still exists as a deprecated type alias.
- `OPSqliteOpenFactory` options now go directly on `new PowerSyncDatabase({ database: { dbFilename } })`.
- The old v1 table syntax was removed.

## 4. Supabase
- `@supabase/supabase-js@2.117.3`. Its only peer is `@opentelemetry/api`, and that's optional. The README says it supports React Native "with fetch polyfills provided by the framework".
- **`react-native-url-polyfill` isn't needed.** Expo 57's built-in runtime (`expo/src/winter/runtime.native.ts`) sets up global `URL` and `URLSearchParams` from `whatwg-url-minimum`.
  - Supabase's own quickstart still imports the polyfill; Expo's Supabase guide doesn't.
  - If URL errors show up on a device, add `react-native-url-polyfill@4.0.0`.
- **Where to store the auth session.**
  - Expo's guide now uses `expo-sqlite/localStorage/install`. I recommend against that here because it adds a second SQLite engine.
  - **Recommended:** an `expo-secure-store` adapter (`getItemAsync`/`setItemAsync`/`deleteItemAsync`), which is backed by the Android Keystore. The probe's version of this typechecks.
  - I found no 2048-byte value limit in the expo-secure-store 57 source (older SDK docs mention one). If sessions turn out too large on a device, fall back to AsyncStorage 2.2.0 or Supabase's LargeSecureStore pattern.
  - Use `detectSessionInUrl: false`. Add the usual AppState hook that calls `supabase.auth.startAutoRefresh()` / `stopAutoRefresh()`. I couldn't re-check this hook against supabase.com, which could not be opened.
- Search results say Supabase is moving to `sb_publishable_…` keys in place of the anon key. Keep AI keys server-side only, behind Edge Functions that call Tracy.

## 5. ts-fsrs 5.4.2: API surface (from `dist/index.d.ts`)
- Implements the **FSRS-6** algorithm (`FSRS6_DEFAULT_DECAY = 0.1542`, `default_w`).
- Functions:
  - `fsrs(params?: Partial<FSRSParameters>): FSRS` (applies `generatorParameters` internally)
  - `generatorParameters(props?): FSRSParameters`
  - `createEmptyCard<R = Card>(now?, afterHandler?)`
  - `forgetting_curve`
  - `Grades`, `fixDate`, `fixState`, `fixRating`
- `FSRSParameters` fields and defaults:
  - `request_retention` (0.9), `maximum_interval` (36500), `w`
  - `enable_fuzz` (**false** by default), `enable_short_term` (true)
  - `learning_steps`, `relearning_steps` (StepUnit strings such as `'1m'`, `'10m'`)
- `FSRS` methods:
  - `repeat(card, now)` returns an `IPreview` with an outcome for each grade
  - `next(card, now, grade)` returns `{card, log}`, optionally passed through `afterHandler`
  - `get_retrievability`, `rollback`, `forget`, `reschedule`, `next_state`, `next_interval`, `useStrategy`
- Enums:
  - `Rating { Manual=0, Again=1, Hard=2, Good=3, Easy=4 }`; `Grade` is Rating without `Manual`
  - `State { New=0, Learning=1, Review=2, Relearning=3 }`
- `Card` fields: `due: Date`, `stability`, `difficulty`, `elapsed_days` (*deprecated, removed in 6.0*), `scheduled_days`, `learning_steps`, `reps`, `lapses`, `state`, `last_review?: Date`.
- `ReviewLog` fields: `rating`, `state`, `due`, `stability`, `difficulty`, `elapsed_days`/`last_elapsed_days` (deprecated), `scheduled_days`, `learning_steps`, `review: Date`.
- **Schema advice:** don't add `elapsed_days` columns. Store dates as ISO text or epoch milliseconds. Store state and rating as integers.
- **Gotcha:** importing ts-fsrs adds `Date.prototype.scheduler/diff/format/dueFormat`. These are deprecated and will be removed in 6.0. Don't rely on them.

## 6. Generating UUIDs on the device
- **Use `expo-crypto`'s `randomUUID()`.** It's synchronous, native and produces UUIDv4. It's already in the SDK, and the probe uses it.
- The `uuid` package (14.0.2, ESM only) needs `crypto.getRandomValues`. Expo 57 does **not** set up a global `crypto`, so you'd also need `react-native-get-random-values@1.11.0` imported first. Skip it unless you want v7 IDs.
- PowerSync's native core binary contains `uuid` and `gen_random_uuid` symbols, which suggests it provides a SQL `uuid()` function. I inferred this from strings in `libpowersync.so`; I didn't run it.

## 7. Concrete config

### package.json
The proposal as researched. The repo's own `package.json` is authoritative (it differs, for example in its scripts).
```json
{
  "main": "expo-router/entry",
  "scripts": {
    "start": "expo start --dev-client",
    "android": "expo run:android",
    "lint": "expo lint",
    "typecheck": "tsc --noEmit",
    "test": "jest"
  },
  "dependencies": {
    "@azure/core-asynciterator-polyfill": "1.0.2",
    "@op-engineering/op-sqlite": "18.2.5",
    "@powersync/react-native": "2.3.1",
    "@react-native-async-storage/async-storage": "2.2.0",
    "@supabase/supabase-js": "2.117.3",
    "expo": "57.0.27",
    "expo-build-properties": "57.0.22",
    "expo-constants": "57.0.21",
    "expo-crypto": "57.0.3",
    "expo-dev-client": "57.0.19",
    "expo-font": "57.0.4",
    "expo-haptics": "57.0.3",
    "expo-linking": "57.0.12",
    "expo-notifications": "57.0.22",
    "expo-router": "57.0.25",
    "expo-secure-store": "57.0.4",
    "expo-splash-screen": "57.0.9",
    "expo-status-bar": "57.0.1",
    "expo-system-ui": "57.0.4",
    "react": "19.2.3",
    "react-native": "0.86.3",
    "react-native-gesture-handler": "2.32.0",
    "react-native-reanimated": "4.5.1",
    "react-native-safe-area-context": "5.7.0",
    "react-native-screens": "4.26.2",
    "react-native-worklets": "0.10.1",
    "ts-fsrs": "5.4.2"
  },
  "devDependencies": {
    "@types/react": "19.2.18",
    "eslint": "9.39.5",
    "eslint-config-expo": "57.0.2",
    "jest-expo": "57.0.5",
    "typescript": "6.0.3"
  },
  "jest": {
    "preset": "jest-expo",
    "transformIgnorePatterns": [
      "/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation|@powersync|@op-engineering|@supabase))",
      "/node_modules/react-native-reanimated/plugin/",
      "/node_modules/@react-native/babel-preset/"
    ]
  }
}
```

**Add later when needed:**
- `@shopify/react-native-skia` 2.6.2
- `@react-native-community/netinfo` 12.0.1
- `react-dom` 19.2.3 and `react-native-web` 0.21.3 (only for web)

**The `jest.transformIgnorePatterns` override is required.** Without it, Jest fails with `SyntaxError: Unexpected token 'export'` in `@powersync/common/lib/index.js`. The extended pattern fixed it.

**Other package.json notes:**
- **Commit `package-lock.json`.** `expo` uses caret ranges for its own internal dependencies, so the lockfile is what actually pins them.
- With pnpm, also list `@react-native/jest-preset@0.86.3` (and `@powersync/common@2.3.1`) explicitly, because pnpm won't install peers automatically the way npm did.

### babel.config.js
**Not needed.** The SDK 57 template doesn't create one. `babel-preset-expo` already covers worklets, async generators and Hermes v1. If you do create one, use exactly this, and **don't** add the reanimated or worklets plugin by hand:
```js
module.exports = function (api) { api.cache(true); return { presets: ['babel-preset-expo'] }; };
```

### metro.config.js
**Not needed.** If you ever add one, start from `const { getDefaultConfig } = require('expo/metro-config'); module.exports = getDefaultConfig(__dirname);`.

### app.json plugins and Android fields
Validated by `expo config` and `prebuild`:
```json
"scheme": "dualrep",
"android": { "package": "com.interverse.dualrep" },
"plugins": [
  "expo-router",
  "expo-secure-store",
  ["expo-splash-screen", { "backgroundColor": "#0B0F14", "image": "./assets/icon.png", "imageWidth": 200 }],
  "expo-font",
  ["expo-notifications", { "color": "#0B0F14" }],
  ["expo-build-properties", { "android": { "enableMinifyInReleaseBuilds": true, "enableShrinkResourcesInReleaseBuilds": true } }]
],
"experiments": { "typedRoutes": true }
```
- `expo install` added the router, secure-store, splash-screen, font and build-properties plugins on its own (plus expo-sqlite, which I removed).
- No plugin entry is needed for PowerSync, op-sqlite, supabase or dev-client.
- Leave out `newArchEnabled` and `edgeToEdgeEnabled`; those fields no longer exist.

## 8. What the probe runs showed
The probe was a throwaway project; it is not part of this repo.

1. **`npx create-expo-app@latest probe --template blank-typescript --yes`** (create-expo-app 5.0.0): OK.
   - Gave expo ~57.0.27, RN 0.86.3, React 19.2.3, TypeScript ~6.0.3, @types/react ~19.2.2.
   - It **also writes `AGENTS.md` and `.claude/settings.json`**, the latter enabling the plugin `expo@claude-plugins-official`. Review both before committing them to DualRep.
2. **`npx expo install …`** failed at first: `api.expo.dev` and `reactnative.directory` were not reachable from the research environment.
   - I re-ran with Expo CLI's offline mode (`EXPO_OFFLINE=1`), which takes versions from the local `bundledNativeModules.json`. It printed "Installing 23 SDK 57.0.0 compatible native modules".
   - The versions it picked match the table above. npm printed **no peer-dependency warnings**. `npm ls` shows only optional peers as unmet (`@sqlite.org/sqlite-wasm`, `@opentelemetry/api`, platform-specific resolver binaries).
   - Quirk: `npx expo install jest-expo eslint-config-expo -- --save-dev` wrote those packages into *both* dependencies and devDependencies. I fixed that by hand.
3. **`npx expo-doctor` (v1.20.4): 19/21 passed.**
   - Passed, among others: SDK version match, peer dependencies, duplicate dependencies, Metro config, native tooling, Hermes V1 regressions, app-store version requirements.
   - Failed: the config schema check ("Host not i…" JSON error, because it fetches from api.expo.dev, which was unreachable) and React Native Directory validation (unreachable host).
   - `npx expo config --type public` resolved the config locally without errors (sdkVersion 57.0.0).
4. **Other checks:**
   - `npx tsc --noEmit` passed, on a smoke app that uses `PowerSyncDatabase`, `useQuery`, a `PowerSyncBackendConnector` with `getNextCrudTransaction`, supabase `createClient` with SecureStore storage, ts-fsrs and `expo-crypto`.
   - `npx expo export --platform android` produced a Hermes bundle `.hbc` of 3.9 MB from 1,402 modules, with **no custom babel or Metro config**.
   - `npx expo lint`: clean.
   - `npx jest`: 2/2 suites passed after the transformIgnorePatterns fix.
5. **`npx expo prebuild --platform android --no-install`**: OK.
   - minSdk, compileSdk and targetSdk come from `rootProject.ext`, which resolves to **24 / 36 / 36** (see section 2).
   - `gradle.properties` has `newArchEnabled=true`.
6. **`./gradlew help`** downloaded Gradle 9.3.1, then failed: no JDK 17 toolchain is installed. There was no Android SDK either, so no APK was built.

## 9. What I couldn't verify
- **No native compile or on-device run.** Not verified: op-sqlite 18.2.5 and PowerSync 2.3.1 compiling with AGP 8.12 / Gradle 9.3.1 / NDK 27; the legacy `NativePowerSyncHelper` working under bridgeless mode; the offline-to-Postgres gate itself.
- **Sites that could not be opened:** docs.powersync.com, expo.dev, supabase.com, api.expo.dev and reactnative.directory. I relied on npm tarballs, raw GitHub files and search snippets instead.
- **Hermes and `Symbol.asyncIterator`:** not checked, which is why I recommend keeping the polyfill.
- **expo-secure-store size limit in SDK 57:** I found nothing in the source, but haven't tested a real Supabase session on a device.
- **TypeScript 7:** untested.

## Sources
- PowerSync RN changelog: https://raw.githubusercontent.com/powersync-ja/powersync-js/main/packages/react-native/CHANGELOG.md
- PowerSync RN README: https://raw.githubusercontent.com/powersync-ja/powersync-js/main/packages/react-native/README.md
- PowerSync docs, seen in search only (not opened): https://docs.powersync.com/client-sdk-references/react-native-and-expo, https://docs.powersync.com/client-sdks/frameworks/expo-go-support, https://releases.powersync.com/announcements/ann_zqI7vcW6upScZ
- Play target API: https://developer.android.com/google/play/requirements/target-sdk, https://support.google.com/googleplay/android-developer/answer/11926878
- Supabase + Expo, seen in search only (not opened): https://docs.expo.dev/guides/using-supabase/, https://supabase.com/docs/guides/getting-started/quickstarts/expo-react-native
- npm registry metadata and tarballs, read directly: expo@57.0.27 (bundledNativeModules.json, template.tgz, src/winter), react-native@0.86.3 (gradle/libs.versions.toml, gradle-plugin), expo-modules-autolinking@57.0.14, expo-modules-core@57.0.21, babel-preset-expo@57.0.14, @powersync/{react-native@2.3.1, common@2.3.1, shared-internals@1.3.1, op-sqlite@0.9.16, adapter-sql-js@0.0.25, attachments@3.0.0}, @op-engineering/op-sqlite@18.2.5, @supabase/supabase-js@2.117.3, ts-fsrs@5.4.2, expo-crypto@57.0.3, expo-secure-store@57.0.4, expo-sqlite@57.0.4
- Maven Central: com.powersync:powersync-sqlite-core:0.5.3 AAR

## Open risks
- No native Android build or on-device run was done here (no Android SDK or JDK 17 toolchain was available). These are unconfirmed: op-sqlite 18.2.5 and PowerSync 2.3.1 compiling under AGP 8.12 / Gradle 9.3.1 / NDK 27.1.12297006, PowerSync's legacy ReactContextBaseJavaModule helper working through New-Arch interop, and the offline-row-to-Postgres gate.
- api.expo.dev and reactnative.directory were unreachable during research, so `npx expo install` ran in EXPO_OFFLINE mode (versions from local bundledNativeModules.json) and expo-doctor's schema and React Native Directory checks could not run (19/21 passed).
- docs.powersync.com, expo.dev and supabase.com could not be opened during research. Claims rest on npm tarballs, raw GitHub files and search snippets. One PowerSync docs snippet still says to install @powersync/op-sqlite, which contradicts the 2.0 changelog and would pull in @powersync/common 1.x; do not install it.
- Not verified whether Hermes in RN 0.86 provides Symbol.asyncIterator; keep @azure/core-asynciterator-polyfill imported first and prefer callback watch/useQuery and getNextCrudTransaction().
- expo-secure-store 57 size limit for a Supabase session is unverified (no 2048-byte limit text in the source, but older docs had one); test on device, falling back to AsyncStorage 2.2.0 or the LargeSecureStore pattern.
- Developers need a JDK 17 toolchain: the RN 0.86 Gradle plugin uses jvmToolchain(17), and JDK 21 alone failed here. They also need Android SDK Platform 36, Build-Tools 36.0.0, NDK 27.1.12297006 and CMake 3.30.5.
- ESLint 9.39.5 is marked deprecated upstream, but `expo lint` hard-requires eslint ^9.0.0; TypeScript 7.0.2 is untested, so stay on 6.0.3.
- Expo SDK 58 is in beta (58.0.6 on the next tag) and RN 0.87.1 is npm latest; expect an SDK upgrade soon after Phase 0. Do not bump reanimated, worklets, skia, gesture-handler or async-storage to npm latest outside an SDK upgrade.
- Jest needs transformIgnorePatterns extended for @powersync, @op-engineering and @supabase (verified failure without it); with pnpm, @react-native/jest-preset@0.86.3 and @powersync/common@2.3.1 must be listed explicitly.
- Targeting API 36 forces edge-to-edge, and orientation locks are ignored on screens 600dp or wider (relevant to the template's orientation: portrait).
- create-expo-app 5.0.0 writes AGENTS.md and .claude/settings.json (enables plugin expo@claude-plugins-official); review before committing to the DualRep repo.
- ts-fsrs 5.4.2 mutates Date.prototype on import (deprecated helpers removed in 6.0); Card.elapsed_days and ReviewLog.elapsed_days/last_elapsed_days are deprecated, so keep them out of the schema.
