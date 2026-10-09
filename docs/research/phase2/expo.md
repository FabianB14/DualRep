# Phase 2 research, track `expo`: phone-side packages and Android effects for uploads

Researched 2026-10-09 against `/home/user/DualRep` (Expo SDK 57.0.27, React Native 0.86.3,
`@supabase/supabase-js` 2.117.3). Nothing in either repo was changed.

**How things were checked.** Each candidate package was downloaded as its npm tarball
(`npm pack <pkg>@<sdk-57 version>`) into `scratch/expo-pkgs/x/` and read directly: the
`android/src/main/AndroidManifest.xml`, the prebuilt AAR manifest in `local-maven-repo/`, the
`plugin/build/*.js` config plugin, the `build/*.d.ts` API and the Kotlin sources. The installed
`expo-file-system`, `@expo/prebuild-config`, `expo-modules-core`, `react-native`, `whatwg-fetch` and
`@supabase/storage-js` were read in `node_modules`. The Supabase docs pages come from their MDX source on
GitHub, because supabase.com is blocked from this sandbox. Android docs were read on developer.android.com.
Anything not read in a primary source is marked **unverified**. Nothing here was run on a phone.

---

## 0. Recommendations in brief

1. **Add four packages, all Expo SDK 57 modules with no native C/C++ code:**
   `expo-document-picker@57.0.3`, `expo-image-picker@57.0.20`, `expo-image-manipulator@57.0.21` and
   `expo-file-system@57.0.7`. `expo-file-system` is **already compiled into the APK**, because `expo`
   depends on it, but it is installed nested under `node_modules/expo/node_modules/`. The app can only
   import it reliably once it is a direct dependency. **Skip** `expo-web-browser` (opening links with
   `Linking.openURL` is enough), `expo-camera` (expo-image-picker's camera covers taking photos) and,
   until the audio spike, `expo-audio` and `expo-speech`.
2. **The APK gains exactly one permission: `android.permission.CAMERA`.** It comes from
   expo-image-picker's library manifest. The other permissions these packages declare are
   `READ_/WRITE_EXTERNAL_STORAGE` (with `maxSdkVersion="32"`) and, through the plugin, `RECORD_AUDIO`.
   `app.config.ts` already blocks all three. Neither package adds `READ_MEDIA_*`, so Play's Photo and
   Video Permissions policy is not triggered.
3. **Adding `CAMERA` has a Play side effect.** Google Play then assumes the app needs
   `android.hardware.camera` and `android.hardware.camera.autofocus`, and hides it from devices that
   lack them. A small inline config plugin can declare both as `required="false"` (§6).
4. **Taking photos does not work on Android 7–9 (API 24–28) as configured.**
   `launchCameraAsync` asks for `CAMERA` and, below API 29, also for `WRITE_EXTERNAL_STORAGE`. DualRep
   blocks `WRITE_EXTERNAL_STORAGE`, so on those phones the call always fails with "user rejected
   permissions". Recommendation: hide **Take a photo** when `Platform.Version < 29`. The gallery and
   file paths work on every Android version.
5. **`microphonePermission: false` on the expo-image-picker plugin removes `RECORD_AUDIO` from the whole
   app** (it writes `tools:node="remove"`). Keep it while audio is off. Remove it in the same PR that
   unblocks `RECORD_AUDIO` for audio study mode, or recording will silently stay denied.
6. **Photo pipeline:** pick or take the photo with `quality: 1` (the bytes are copied as-is, with no
   decode). Then do one pass through expo-image-manipulator: shrink the long edge to **2576 px**
   (Claude's high-resolution limit) and save as JPEG at `compress: 0.8`. That one pass also converts
   HEIC to JPEG (Claude accepts only JPEG, PNG, GIF and WebP) and **removes the EXIF data, including
   GPS**. expo-image-picker itself copies GPS tags into its own compressed output.
7. **Upload natively with expo-file-system:** `new File(uri).upload(url, …)` POSTs to Storage's REST
   endpoint. OkHttp streams the file from disk and reports progress, so the file never passes through
   JavaScript. Through supabase-js, `.upload(path, await file.bytes(), { contentType, upsert: true })`
   also works. In React Native, though, the body is copied and base64-encoded in JavaScript, so memory
   briefly peaks at about 3–4× the file size. That is fine for photos and costly for a 25 MB PDF.
8. **Make uploads survive being offline.** Copy each picked file into `Paths.document/pending-uploads/`,
   not the cache. Track it in a local-only PowerSync table. Upload the file first and insert the
   `source_files` row only after the upload succeeds, so Postgres never points at a missing file.

---

## 1. Versions (SDK 57)

Versions come from `node_modules/expo/bundledNativeModules.json` (installed `expo` 57.0.27). Each one
equals the npm `sdk-57` dist-tag and `latest`, checked 2026-10-09.

| Package | SDK 57 version | Published | In the repo today |
|---|---|---|---|
| expo-document-picker | `~57.0.3` | 2026-09-29 | no |
| expo-image-picker | `~57.0.20` | 2026-09-24 | no |
| expo-image-manipulator | `~57.0.21` | 2026-10-06 | no |
| expo-file-system | `~57.0.7` | 2026-09-11 | **nested** `node_modules/expo/node_modules/expo-file-system` 57.0.7 (a dependency of `expo`); **already autolinked** (`npx expo-modules-autolinking resolve -p android` lists `expo-file-system@57.0.7`) |
| expo-image-loader (dependency of image-picker and image-manipulator) | `~57.0.1` | 2026-07-15 | no |
| expo-speech | `~57.0.3` | 2026-09-11 | no |
| expo-audio | `~57.0.5` | 2026-09-11 | no |
| expo-web-browser | `~57.0.3` | 2026-09-11 | no |
| expo-background-task / expo-task-manager | `~57.0.21` | — | no |

- None of these packages contains `.so`, `.cpp` or `CMakeLists.txt`, and their prebuilt AARs contain no
  `.so`. `scripts/check-16kb.sh` should therefore stay green; CI will confirm.
- The repo pins exact versions (`package.json` uses no `~`). Install with
  `npm install --save-exact expo-document-picker@57.0.3 expo-image-picker@57.0.20 expo-image-manipulator@57.0.21 expo-file-system@57.0.7`,
  then run `npx expo install --check` to confirm SDK alignment.

---

## 2. Package by package

### 2.1 expo-document-picker 57.0.3: PDF and DOCX

- **Manifest:** a `<queries>` entry for `OPEN_DOCUMENT` only. **No permissions.**
- **Config plugin:** affects iOS only (iCloud entitlements). It is in `@expo/prebuild-config`'s
  `versionedExpoSDKPackages`, so it runs automatically. **No `app.config.ts` entry is needed.**
- **Android implementation** (`DocumentPickerModule.kt`): `Intent.ACTION_OPEN_DOCUMENT` with
  `CATEGORY_OPENABLE`. More than one type becomes `type="*/*"` plus `EXTRA_MIME_TYPES`, and `multiple`
  maps to `EXTRA_ALLOW_MULTIPLE`. The name, size and MIME type come from
  `OpenableColumns.DISPLAY_NAME`/`SIZE` and `ContentResolver.getType`.
- With `copyToCacheDirectory: true` (the default), the module copies the file to
  `cacheDir/DocumentPicker/<uuid>.<ext>` inside `OnActivityResult`, before the promise resolves. That
  copy is probably on the main thread (**unverified**). Nothing limits the size, so picking a 500 MB file
  stalls the app before DualRep can check it.
- **API** (`build/index.d.ts`):
  ```ts
  getDocumentAsync({ type?: string | string[]; copyToCacheDirectory?: boolean; multiple?: boolean; base64?: boolean /* web */ })
    : Promise<{ canceled: false; assets: { uri: string; name: string; size?: number; mimeType?: string; lastModified: number }[] }
             | { canceled: true; assets: null }>
  ```
- **Recommended call:**
  ```ts
  await DocumentPicker.getDocumentAsync({
    type: ['application/pdf',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    multiple: true,               // each asset becomes its own `sources` row
    copyToCacheDirectory: false,  // returns content://; check asset.size first, then copy (§8)
  });
  ```
  Some file managers ignore `EXTRA_MIME_TYPES`, so re-check `mimeType` and the file extension after the
  pick. The grant on a `content://` result lasts only while the app is alive (DualRep does not take a
  persistable permission), so copy the file straight away. If copying a content URI with
  expo-file-system turns out to misbehave on a device, fall back to `copyToCacheDirectory: true`. Copying
  `content://` sources is implemented in `FileSystemPath.copy` → `CopyMoveStrategy.ContentProvider`,
  which runs on `Dispatchers.IO`.
- **Compared with `File.pickFileAsync` in expo-file-system 57**, which would avoid a new module: it
  also uses `ACTION_OPEN_DOCUMENT`, but `CATEGORY_OPENABLE` is commented out in
  `FilePickerContract.kt`, so virtual files that can't be opened as streams can be picked. It also calls
  `takePersistableUriPermission` on every pick and never releases the grant. Android caps the number of
  persisted grants (the cap itself is **unverified**). **Use expo-document-picker.**

### 2.2 expo-image-picker 57.0.20: gallery and camera

**Library manifest** (the same in the source and the prebuilt AAR):
```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
<!-- application: com.google.android.gms.metadata.ModuleDependencies service (photo picker backport),
     com.canhub.cropper.CropImageActivity (exported="false" via tools:replace),
     expo.modules.imagepicker.ExpoCropImageActivity, provider .fileprovider.ImagePickerFileProvider
     (${applicationId}.ImagePickerFileProvider) -->
<!-- queries: android.media.action.IMAGE_CAPTURE, android.media.action.ACTION_VIDEO_CAPTURE -->
```
Its dependency `com.vanniktech:android-image-cropper:4.7.0` was read from its AAR: it declares **no
permissions**, only a FileProvider, `CropImageActivity` and queries for `GET_CONTENT` and
`IMAGE_CAPTURE`. The other dependencies are `androidx.exifinterface`, `androidx.activity` and
`expo-image-loader` (which brings Glide 5.0.5). None of them contains native code.

**Config plugin** (`plugin/build/withImagePicker.js`), whose options are
`{ photosPermission, cameraPermission, microphonePermission, colors, dark }`:
- `microphonePermission !== false` → **adds `android.permission.RECORD_AUDIO`.**
- `microphonePermission === false` → `withBlockedPermissions(['android.permission.RECORD_AUDIO'])`, which
  **removes it for every library**.
- `cameraPermission === false` → blocks `CAMERA`. **That breaks `launchCameraAsync`** (see below).
  Only use it if the app drops in-app capture.
- `photosPermission` affects iOS only. `colors` and `dark` theme the crop screen.
- expo-image-picker is in `@expo/prebuild-config`'s `legacyExpoPlugins` list
  (`withDefaultPlugins.js:185`). **Once it is installed, the plugin runs even if `app.config.ts` doesn't
  list it**, with no options, so it adds `RECORD_AUDIO`. List it explicitly. `createRunOncePlugin` makes
  the listed entry win.

**Code paths that matter** (`ImagePickerModule.kt`):
- `launchImageLibraryAsync` uses androidx `PickVisualMedia` / `PickMultipleVisualMedia` (the Android
  Photo Picker) and asks for **no permission**. On Android 4.4–10 and Android Go 11–12, Google Play
  services can install a backport. The manifest's `ModuleDependencies` service enables that, and without
  it the library falls back to `ACTION_OPEN_DOCUMENT` (developer.android.com, photo picker page).
  `legacy: true` switches to `ACTION_GET_CONTENT`.
- `launchCameraAsync` calls `ensureCameraPermissionsAreGranted()`, which requests `CAMERA`, **plus
  `WRITE_EXTERNAL_STORAGE` when `SDK_INT < 29`**, and throws `UserRejectedPermissionsException` unless
  all are granted. It then fires `MediaStore.ACTION_IMAGE_CAPTURE` with `EXTRA_OUTPUT` pointing at a
  FileProvider URI in the cache, so the system camera app takes the photo.
  - On API 24–28, DualRep blocks `WRITE_EXTERNAL_STORAGE`. Android answers a request for a permission
    that isn't in the manifest with DENIED and no dialog (standard behaviour; `PermissionsService.kt`
    passes the request through to `Activity.requestPermissions`). **So the camera fails on Android 7–9.**
  - The camera intent itself needs no permission **unless** the app declares `CAMERA`. MediaStore docs:
    *"if you app targets M and above and declares as using the Manifest.permission.CAMERA permission
    which is not granted, then attempting to use this action will result in a SecurityException."*
    expo-image-picker declares `CAMERA` and always asks for it, so there is **no permission-free
    camera through expo-image-picker**. Alternatives are in §2.6.
- `requestMediaLibraryPermissionsAsync` asks for nothing on API 33+ and for READ/WRITE_EXTERNAL_STORAGE
  below that, which DualRep blocks. **DualRep should never call it**, because the picker doesn't need it.
- `getPendingResultAsync()` recovers a result when Android kills `MainActivity` while the camera app is
  in front. Call it when the upload screen mounts.

**Options and output** (`ImagePicker.types.d.ts`; `MediaHandler.kt`):
- `quality` defaults to 1.0. **At exactly 1.0, `RawImageExporter` copies the original bytes**: no
  decode, EXIF kept, and the dimensions come from `DimensionsExporter`, which **swaps width and height
  for EXIF rotations of 90 or 270 degrees**. Below 1.0, `CompressionImageExporter` decodes the full
  bitmap, re-encodes it and then **copies the EXIF tags back, including `TAG_GPS_LATITUDE` and
  `TAG_GPS_LONGITUDE`** (`copyExifData` in `ImagePickerUtils.kt`; `EXIF_TAGS` in
  `ImagePickerConstants.kt`).
- `exif: false` and `base64: false` are the defaults; leave them off. `allowsEditing` opens the canhub
  cropper (single image only); leave it off. `allowsMultipleSelection` and `selectionLimit` work on
  Android. Use `mediaTypes: ['images']`; the `MediaTypeOptions` enum is deprecated.
- The output is a `file://` URI in `cacheDir/ImagePicker/`, and the asset carries `width`, `height`,
  `fileName`, `fileSize`, `mimeType` and `assetId`.
- The Android Photo Picker only lists media on the phone (and cloud photos from Google Photos). Images
  kept in Drive or Files can be picked through the document picker with type `image/*`.

### 2.3 expo-image-manipulator 57.0.21, with expo-image-loader 57.0.1

- **Manifest:** empty. **No permissions and no plugin.**
- **API** (`build/*.d.ts`): `ImageManipulator.manipulate(source: string | SharedRef<'image'>)` returns
  an `ImageManipulatorContext`. That context offers `.resize({width?, height?})`, `.rotate(deg)`,
  `.flip('vertical'|'horizontal')`, `.crop({originX, originY, width, height})` and `.reset()`, then
  `.renderAsync()` returns an `ImageRef` (`width`, `height`), and
  `ImageRef.saveAsync({ format?: SaveFormat.JPEG|PNG|WEBP, compress?: 0..1, base64?: boolean })` returns
  `{ uri, width, height, base64? }`. The hook form is `useImageManipulator`. The old
  `manipulateAsync(uri, actions, saveOptions)` still exists but is `@deprecated`.
- **Android details** (`ImageManipulatorModule.kt`, `ResizeTransformer.kt`, `ImageLoaderService.kt`):
  - Images are decoded by Glide (`asBitmap().diskCacheStrategy(NONE).skipMemoryCache(true)`) at full
    size. Glide applies the EXIF rotation, which is standard Glide behaviour (**not tested here**).
  - `resize` with only one dimension keeps the aspect ratio. **It also enlarges small images**, and
    passing both dimensions distorts the image, so pass only the long edge, and only when the image is
    bigger than the target.
  - `saveAsync` calls `Bitmap.compress` into `cacheDir/ImageManipulator/<uuid>.jpg`. The defaults are
    `compress: 1.0` and `format: JPEG`. **No EXIF is written, so GPS is removed.**
  - Free the native bitmap after saving: `release()` exists on `SharedObject` (`expo-modules-core`).
- **Memory risk:** a full-size ARGB bitmap takes 4 bytes per pixel. A 12 MP photo is about 48 MB; a 50
  or 108 MP "full resolution" shot is about 200–430 MB and can run out of memory. There is no
  "decode at a smaller size" option. Refuse or warn above about 40 MP (`asset.width * asset.height`).
- HEIC decoding relies on the platform decoder (API 28+). That HEIC files can't be decoded on API 24–27
  is **unverified**, and such files are rare there anyway.

### 2.4 expo-file-system 57.0.7 (the new `File` / `Directory` / `Paths` API)

- **Manifest:** `INTERNET`, plus `READ_/WRITE_EXTERNAL_STORAGE` with `maxSdkVersion="32"` (already
  blocked), a `FileSystemFileProvider` and a query for `OPEN_DOCUMENT_TREE`. Its legacy auto-plugin
  (`withFileSystem.js`) adds `READ/WRITE_EXTERNAL_STORAGE` and `INTERNET`. All of this **is already in
  today's build**, and the existing `blockedPermissions` handle it.
- **Imports:** `import { File, Directory, Paths } from 'expo-file-system'`. The old API is at
  `'expo-file-system/legacy'`.
- **Reading files** (`internal/NativeFileSystem.types.d.ts`; `src/File.ts:186`):
  `bytes(): Promise<Uint8Array>`, `bytesSync()`, `base64()`, `text()`, and
  `arrayBuffer(): Promise<ArrayBuffer>`, which is implemented in JavaScript as `(await this.bytes()).buffer`.
  The getters are `size` (0 if the file is missing), `type` (MIME), `md5`, `name`, `extension`,
  `exists` and `contentUri`. The operations are `copy(dest)` and `move(dest)` (async, on an IO thread,
  and they accept `content://` sources), `delete()`, `create()` and `open(mode)` (a `FileHandle` with
  `readBytes(n)`).
- **Uploading** (`NetworkTasks.types.d.ts`; `FileSystemUploadTask.kt`): `file.upload(url, options)` and
  `file.createUploadTask(url, options)` take
  `{ httpMethod?: 'POST'|'PUT'|'PATCH' (default POST), uploadType?: UploadType.BINARY_CONTENT (default)|MULTIPART, headers?, fieldName?, mimeType?, parameters?, onProgress?({bytesSent,totalBytes}), signal? }`
  and resolve to `{ status, headers, body }`. **They resolve for non-2xx responses too**, so check
  `status`. They reject only on I/O errors or a cancel. The OkHttp client has 60 s connect, read and
  write timeouts. **A binary body is sent with no media type** (`asRequestBody(null)`), so pass
  `Content-Type` in `headers`; the `mimeType` option only applies to multipart.
- **Folders:** `Paths.document` survives until uninstall (and is not in Android backups, because
  `allowBackup: false`). `Paths.cache` "can be deleted by the system when the device runs low on
  storage", so it is the wrong place for an upload queue. `Paths.availableDiskSpace` reports free space.
  `new Directory(Paths.document, 'pending-uploads').create({ intermediates: true, idempotent: true })`.

### 2.5 Audio study mode and reminders (for 2.1–2.5; not needed for uploads)

| Package | Android manifest / plugin effect (read in source) | Notes |
|---|---|---|
| expo-audio 57.0.5 | Library manifest: **`MODIFY_AUDIO_SETTINGS`**, which the ledger doesn't list. Plugin defaults: `recordAudioAndroid = true` → `RECORD_AUDIO`; `enableBackgroundPlayback = true` → `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` and the service `expo.modules.audio.service.AudioControlsService` (`foregroundServiceType="mediaPlayback"`); `enableBackgroundRecording = false` (true → `FOREGROUND_SERVICE_MICROPHONE`, `POST_NOTIFICATIONS`, `AudioRecordingService` of type `microphone`). Its media3 1.9.0 dependency adds `ACCESS_NETWORK_STATE` and `WAKE_LOCK` (media3-exoplayer and common manifests on GitHub at tag 1.9.0; media3-session declares none). | **Not** in `legacyExpoPlugins`, so the plugin only runs when listed. On Android, background playback needs `player.setActiveForLockScreen(true, …)` with `interruptionMode: 'doNotMix'`; otherwise it "will stop after approximately 3 minutes" (`Audio.types.d.ts:557`). |
| expo-speech 57.0.3 | **No permissions.** Only a query for `android.intent.action.TTS_SERVICE`. No plugin. | API: `speak(text, {language, pitch, rate, voice, volume, onStart, onDone, onStopped, onError, onBoundary, …})`, `stop()`, `pause()`, `resume()`, `isSpeakingAsync()`, `getAvailableVoicesAsync()`, `maxSpeechInputLength`. Whether text-to-speech keeps playing with the screen off on Android 17 is **unverified** (ANDROID.md 2.4 spike). |
| expo-web-browser 57.0.3 | **No permissions.** `BrowserProxyActivity`, a query for `CustomTabsService`, and a plugin that does nothing unless `experimentalLauncherActivity` is set. | Not needed: link sources are fetched on the server, and `Linking.openURL` opens them on the phone. |
| expo-background-task 57.0.21 (+ expo-task-manager) | WorkManager (`work-runtime-ktx 2.9.1`) declares `WAKE_LOCK`, `ACCESS_NETWORK_STATE`, `RECEIVE_BOOT_COMPLETED` and **`FOREGROUND_SERVICE`** (read on androidx-main; for 2.9.1 **unverified**). task-manager adds a `BOOT_COMPLETED` receiver and a JobService. | Optional (ANDROID.md 2.5). The daily "reviews due" reminder needs **no new package**: expo-notifications 57.0.22 has `SchedulableTriggerInputTypes.DAILY {hour, minute, channelId}`, and without exact-alarm access it schedules with `setAndAllowWhileIdle` (`ExpoSchedulingDelegate.kt:105-121`). |

### 2.6 Taking a photo without `CAMERA`: alternatives considered

| Option | Permission | Effort and risk | Verdict |
|---|---|---|---|
| expo-image-picker `launchCameraAsync` | `CAMERA` (asked in context) | None; it is the SDK module | **Use it for Phase 2.** Hide it on API < 29. |
| A local Expo module (`modules/`, about 60 lines of Kotlin) using `ActivityResultContracts.TakePicture()` and a FileProvider, with `cameraPermission: false` on the image-picker plugin | **none**: the camera intent needs no permission when `CAMERA` isn't declared (MediaStore docs, quoted in §2.2) | Native code the founder must maintain; it must never call `launchCameraAsync` | Possible later, to drop `CAMERA`. |
| ML Kit Document Scanner (`react-native-document-scanner-plugin@2.0.4`, `play-services-mlkit-document-scanner:16.0.0`) | The package manifest is empty. Third-party write-ups say no camera permission is needed because the UI runs inside Google Play services (**unverified**; developers.google.com is blocked here) | Third-party, needs Play services, Beta status **unverified** | Interesting for notes later: automatic cropping, deskewing and multiple pages. |
| expo-camera 57.0.6 | `CAMERA`, plus ML Kit barcode metadata | An in-app viewfinder; more UI to build | No. |

---

## 3. Reading a file and uploading it from React Native 0.86 (verified code paths)

**Reading bytes.** Both ways work on Android according to the source; neither was run on a device.
- `await new File(uri).bytes()` (or `.arrayBuffer()`) makes one native read into a JavaScript typed
  array. **Preferred.**
- `await (await fetch(uri)).arrayBuffer()`: RN's `BlobModule.networkingUriHandler` serves any
  non-http(s) URI when `responseType == "blob"`, and whatwg-fetch 3.6.20 asks for a blob. Then
  `FileReader.readAsArrayBuffer` is implemented as **`readAsDataURL` → base64 → `toByteArray`**
  (`Libraries/Blob/FileReader.js:74-94`). That works, but with two base64 hops.

**supabase-js 2.117.3 storage** (`@supabase/storage-js/dist/index.mjs`):
- `upload(path, fileBody: FileBody, fileOptions?: { cacheControl?, contentType?, upsert?, duplex?, metadata?, headers? })`,
  where `FileBody = ArrayBuffer | ArrayBufferView | Blob | Buffer | File | FormData | NodeJS.ReadableStream | ReadableStream<Uint8Array> | URLSearchParams | string`.
  It returns `{ data: { id, path, fullPath }, error: null } | { data: null, error: StorageError }`.
- For a body that is neither a Blob nor FormData, it **sets `content-type` from `options.contentType`,
  and `DEFAULT_FILE_OPTIONS.contentType` is `"text/plain;charset=UTF-8"`** (line 598). **Always pass
  `contentType`.** `upsert` becomes the `x-upsert` header on POST. The request goes to
  `POST ${url}/object/${bucket}/${path}`.
- The typings note: *"For React Native, using either `Blob`, `File` or `FormData` does not work as
  intended. Upload file using `ArrayBuffer` …"*.
- **Do not pass an expo `File` object** as the body. It isn't a JavaScript `Blob`, so it is passed
  through untouched, and whatwg-fetch's fallback turns unknown bodies into
  `Object.prototype.toString.call(body)`. The exact result is **unverified**, but it is not the file.
- How an ArrayBuffer or Uint8Array body reaches the network: whatwg-fetch first copies it
  (`bufferClone`), then RN's `XMLHttpRequest.send` → `convertRequestBody` turns it into
  **`{ base64: binaryToBase64(body) }`** (`Libraries/Network/convertRequestBody.js`). So JavaScript holds
  the original, a copy and a base64 string (about 1.33×) at the same moment: roughly 3–4× the file size.
- `createSignedUrl(path, expiresIn, { download?, transform?, cacheNonce?, versionId? })` →
  `{ data: { signedUrl } }`. It POSTs to `/object/sign/<bucket>/<path>`, needs the **SELECT** RLS
  permission on `storage.objects`, and returns the URL already `encodeURI`'d. Image `transform` is a
  paid feature (**unverified**); don't use it.
- `createSignedUploadUrl(path, { upsert })` → `{ signedUrl, token, path }`, valid for 2 hours and needing
  the INSERT permission. `uploadToSignedUrl(path, token, body, opts)` sends a PUT to
  `/object/upload/sign/<bucket>/<path>?token=…`. Not needed while the phone holds a user JWT.

**Native upload straight to Storage's REST endpoint.** The endpoint is from the Supabase docs (MDX
source): `POST https://<ref>.supabase.co/storage/v1/object/{bucket}/{path}` with the headers `apikey`,
`Authorization: Bearer <user JWT>` and `Content-Type`, plus `x-upsert: true` to overwrite. **Storage
infers the content type from the extension only when none is sent**, but the allowed-MIME check on the
sibling draft bucket compares against what is sent, so send it explicitly.

---

## 4. Size limits

| Layer | Limit | Source |
|---|---|---|
| Supabase global file size, Free plan | **50 MB** (Pro and up: up to 500 GB) | docs `storage/uploads/file-limits.mdx` |
| Bucket `sources` (sibling backend draft) | `file_size_limit = 26214400` (25 MiB). MIME allow-list: pdf, jpeg, png, webp, heic, heif, text/plain, text/markdown, docx | `scratch/20261009120000_study_backend.sql:33-41` |
| Standard (non-resumable) upload | Recommended ≤ **6 MB**; up to 5 GB works, and TUS resumable upload is recommended above 6 MB "for better reliability" | docs `standard-uploads.mdx:11-17` |
| Claude images (Tracy's handwriting task) | JPEG, PNG, GIF and WebP only; **10 MB per image (base64) on the Claude API**; at most 8000×8000 px; images are scaled down above a **2576 px long edge (Claude 4.7 and later, high-resolution tier)**, 1568 px for older models; URL sources are supported; "Claude does not parse or receive any metadata" | platform.claude.com/docs/en/build-with-claude/vision |
| Claude PDFs | 32 MB per request, 600 pages | claude-api skill quick reference |
| Edge Function memory | 256 MB | TRACY_INTEGRATION.md §6 (marked verify there) |
| Phone, supabase-js upload | JavaScript peaks at about 3–4× the file size | §3 |
| Phone, `File.upload` | Streams from disk; 60 s inactivity timeouts | §2.4 |
| Phone, manipulator decode | About 4 bytes per pixel (12 MP ≈ 48 MB) | §2.3 |
| Pickers | No limit; check `asset.size` / `fileSize` against 25 MiB **before** copying | §2.1, §2.2 |

The phone should enforce `MAX_UPLOAD_BYTES = 25 * 1024 * 1024` itself, matching the bucket, so the user
gets a clear message instead of a 413 or 400 from Storage. With a 25 MiB cap, a standard upload is
acceptable; TUS (`tus-js-client`) is not worth adding in Phase 2.

---

## 5. Minimal package set

| Add | Why |
|---|---|
| `expo-document-picker@57.0.3` | PDF and DOCX picking with `CATEGORY_OPENABLE`, name and size before copying, no permissions |
| `expo-image-picker@57.0.20` | Photo Picker (no permission) and system camera (`CAMERA`) |
| `expo-image-manipulator@57.0.21` | Shrink to 2576 px, convert HEIC to JPEG, remove EXIF and GPS |
| `expo-file-system@57.0.7` | Make the existing native module a direct dependency so imports resolve: `File.bytes()`, `File.copy/move`, `File.upload` with progress, `Paths.document` |

Not now: `expo-web-browser`, `expo-camera`, `expo-media-library` (it would add `READ_MEDIA_*`; never
add it), `expo-sharing`, `expo-print`, `expo-intent-launcher`. Audio packages wait for the spike.

---

## 6. `app.config.ts` changes (proposed)

```ts
import { withAndroidManifest, type ConfigPlugin } from 'expo/config-plugins';

// CAMERA (from expo-image-picker's manifest) makes Google Play assume android.hardware.camera and
// android.hardware.camera.autofocus are required and hide the app from devices without them. Taking a
// photo is optional in DualRep (gallery and files always work), so declare both as not required.
const withOptionalCamera: ConfigPlugin = (config) =>
  withAndroidManifest(config, (c) => {
    const features = (c.modResults.manifest['uses-feature'] ??= []);
    for (const name of ['android.hardware.camera', 'android.hardware.camera.autofocus']) {
      if (!features.some((f) => f.$['android:name'] === name)) {
        features.push({ $: { 'android:name': name, 'android:required': 'false' } });
      }
    }
    return c;
  });
```
`'uses-feature'` is typed in `@expo/config-plugins/build/android/Manifest.d.ts:116-133`. The camera →
camera + autofocus implication is Table 2 of developer.android.com's `<uses-feature>` page. Apply the
plugin by wrapping the exported config (`export default (ctx) => withOptionalCamera(buildConfig(ctx))`)
or as a function entry in `plugins` (run `tsc` on whichever is chosen).

In `android.blockedPermissions` (`app.config.ts:89`), **keep** `READ_/WRITE_EXTERNAL_STORAGE` and
`RECORD_AUDIO`, and **add guards** so no future library can bring in broad photo access (Play's Photo
and Video Permissions policy):
```ts
      // Phase 2: photos come from the system Photo Picker and camera; never broad media access.
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
      'android.permission.ACCESS_MEDIA_LOCATION',
```

In `plugins` (`app.config.ts:110`):
```ts
    // Phase 2 uploads (docs/ANDROID.md 2.7). Its library manifest adds CAMERA (launchCameraAsync needs
    // it) and READ/WRITE_EXTERNAL_STORAGE ≤ API 32 (blocked above). Without this entry the plugin still
    // runs (a "legacy" auto-plugin) and adds RECORD_AUDIO. `microphonePermission: false` writes
    // tools:node="remove" for RECORD_AUDIO, so drop it in the PR that unblocks RECORD_AUDIO for audio mode.
    ['expo-image-picker', { microphonePermission: false }],
```
Neither expo-document-picker, expo-image-manipulator nor expo-file-system needs an entry.

---

## 7. Expected APK permission list (preview variant, `aapt2 dump permissions`)

After the upload packages are added:
```
permission:      com.interverse.dualrep.preview.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION
uses-permission: android.permission.INTERNET
uses-permission: android.permission.VIBRATE
uses-permission: com.interverse.dualrep.preview.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION
uses-permission: android.permission.RECEIVE_BOOT_COMPLETED
uses-permission: android.permission.POST_NOTIFICATIONS
uses-permission: android.permission.ACCESS_NETWORK_STATE
uses-permission: android.permission.WAKE_LOCK
uses-permission: android.permission.CAMERA            <- new (expo-image-picker)
```
These must **not** appear: `READ_/WRITE_EXTERNAL_STORAGE`, `RECORD_AUDIO`, `READ_MEDIA_*`, any
`FOREGROUND_SERVICE*`. `<queries>` entries (IMAGE_CAPTURE, VIDEO_CAPTURE, OPEN_DOCUMENT,
OPEN_DOCUMENT_TREE, GET_CONTENT) are package-visibility declarations, not permissions, and no
`QUERY_ALL_PACKAGES` is added.

Later, with audio mode configured as in ANDROID.md 2.1: add `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`,
`FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` and `FOREGROUND_SERVICE_MICROPHONE`. With
expo-background-task, `FOREGROUND_SERVICE` comes from WorkManager (**verify** on CI).

**CI suggestion:** `android.yml` prints the list (line 105) but never fails. Add an allow-list
comparison per variant, and `aapt2 dump badging <apk> | grep uses-feature` to confirm
`android.hardware.camera` is `not-required`. A regression such as `RECORD_AUDIO` reappearing because a
plugin option was dropped would then fail the build.

---

## 8. Upload flow sketch (APIs as verified above; not compiled)

```ts
// src/features/sources/files.ts (sketch)
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;          // = bucket file_size_limit
const NOTE_LONG_EDGE = 2576;                                // Claude 4.7+ high-resolution long edge
export const DOC_TYPES = ['application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

/** expo-image-picker also demands WRITE_EXTERNAL_STORAGE below API 29, which DualRep blocks. */
export const canTakePhoto = Platform.OS !== 'android' || (Platform.Version as number) >= 29;

const photoOptions: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'], quality: 1 /* raw copy, no decode */, exif: false, base64: false, allowsEditing: false,
};

export async function pickDocuments() {
  const r = await DocumentPicker.getDocumentAsync({ type: DOC_TYPES, multiple: true, copyToCacheDirectory: false });
  return r.canceled ? [] : r.assets;                        // check a.size and a.mimeType next
}
export async function pickNotePhotos() {
  const r = await ImagePicker.launchImageLibraryAsync({ ...photoOptions, allowsMultipleSelection: true, selectionLimit: 20 });
  return r.canceled ? [] : r.assets;
}
export async function takeNotePhoto() {                      // only when canTakePhoto
  const p = await ImagePicker.requestCameraPermissionsAsync(); // ask in context
  if (!p.granted) return null;
  const r = await ImagePicker.launchCameraAsync(photoOptions);
  return r.canceled ? null : r.assets[0];
}

/** One decode: EXIF rotation applied, long edge ≤ 2576, JPEG 0.8, EXIF/GPS removed, HEIC → JPEG. */
export async function prepareNotePhoto(a: ImagePicker.ImagePickerAsset) {
  const ctx = ImageManipulator.manipulate(a.uri);
  if (Math.max(a.width, a.height) > NOTE_LONG_EDGE) {        // width/height are 0 if unknown: render first, then decide
    ctx.resize(a.width >= a.height ? { width: NOTE_LONG_EDGE } : { height: NOTE_LONG_EDGE });
  }
  const img = await ctx.renderAsync();
  try { return await img.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 }); }
  finally { img.release(); ctx.release(); }
}

/** Copy into the app's own folder (the cache can be cleared); the queue survives restarts. */
const pending = new Directory(Paths.document, 'pending-uploads');
export async function stage(srcUri: string, fileId: string, ext: string) {
  pending.create({ intermediates: true, idempotent: true });
  const src = new File(srcUri);
  if (src.size > MAX_UPLOAD_BYTES) throw new Error('DUALREP_FILE_TOO_LARGE');
  const dest = new File(pending, `${fileId}.${ext}`);
  await src.copy(dest);                                     // content:// or file://, on an IO thread
  return dest;
}

/** Native streaming upload to Storage; path = `${userId}/${sourceId}/${fileId}.${ext}`. */
export async function uploadStaged(file: File, path: string, contentType: string,
  accessToken: string, supabaseUrl: string, publishableKey: string,
  onProgress?: (p: { bytesSent: number; totalBytes: number }) => void) {
  const res = await file.upload(`${supabaseUrl}/storage/v1/object/sources/${path}`, {
    httpMethod: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,  // from supabase.auth.getSession(), which refreshes when online
      apikey: publishableKey,
      'Content-Type': contentType,             // binary bodies carry no type unless set here
      'x-upsert': 'true',                      // a retry of the same path succeeds (needs select+update policies)
      'cache-control': 'max-age=3600',
    },
    onProgress,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`storage ${res.status}: ${res.body}`);
  file.delete();
}
// Small files through supabase-js instead:
//   supabase.storage.from('sources').upload(path, await file.bytes(), { contentType, upsert: true })
// Preview a stored file (needs a SELECT policy on storage.objects):
//   const { data } = await supabase.storage.from('sources').createSignedUrl(path, 600)
```

**Ordering with PowerSync.**
1. Write a row to a **local-only** table, for example `pending_uploads(id = source_files.id, source_id,
   local_uri, storage_path, content_type, page, attempts, last_error)`. Local-only tables need no
   migration (DATA_MODEL.md).
2. Upload while online.
3. Only then insert the `source_files` row with `storage_path`.

This way Postgres and the worker never see a `source_files` row without its object. The backend track
must decide what starts processing, so that a `sources` row with zero files isn't picked up early.
Delete `pending-uploads/` when a different account signs in.

---

## 9. Doc updates this implies (for the implementation PR)

- **ANDROID.md 2.7:**
  - Add the API < 29 camera limitation.
  - Add the Play camera-feature filter and the `uses-feature required="false"` fix.
  - Note that `microphonePermission: false` *removes* `RECORD_AUDIO` app-wide.
  - Note that the plugin runs automatically even when unlisted.
  - Add `quality: 1` plus the manipulator, for EXIF and GPS removal.
- **Permission ledger (ANDROID.md:63):**
  - Add `MODIFY_AUDIO_SETTINGS` (expo-audio library manifest).
  - Add `FOREGROUND_SERVICE` through WorkManager if expo-background-task is added.
  - Add the `READ_MEDIA_*` / `ACCESS_MEDIA_LOCATION` guard blocks.
  - Change the `CAMERA` row to "Play Console: nothing; `uses-feature` not required".
- **ANDROID.md 5.5 Data safety:** because GPS is removed before upload, uploaded photos don't collect
  location; keep "Photos" and "Files and docs".
- **ROADMAP Phase 2 → Build:** "upload flow" depends on the four packages above; the gate's
  "a page of handwritten notes" path also works on Android 7–9 through the gallery.

---

## 10. Open risks and items not verified

1. **None of this ran on a phone.** The camera intent, `content://` copy, Glide EXIF rotation,
   `File.upload` to Storage and the `bytes()` → supabase-js path come from source reading only. One
   preview APK built by CI and a 10-minute manual test settle them.
2. **Camera on Android 7–9:** fails by design with the current blocks. Hide it, or unblock
   `WRITE_EXTERNAL_STORAGE` with `maxSdkVersion="28"`, which needs a `tools:replace` config plugin and is
   not recommended.
3. **Large photos** (50 MP and up) can run out of memory during the single decode. Add a megapixel guard.
4. **`RECORD_AUDIO` coupling** between the image-picker plugin option and audio mode (§0.5).
5. **Play listing filter** if the `uses-feature` plugin is forgotten: tablets and Chromebooks without a
   rear or autofocus camera can't install the app.
6. **Upload reliability over mobile data** for 10–25 MB PDFs with a standard (non-resumable) POST.
   Retries are idempotent through `x-upsert`, but restart from zero.
7. **Unverified:**
   - ML Kit Document Scanner's "no camera permission" claim and its Beta status.
   - Play photo and video policy dates (from search summaries; support.google.com is blocked).
   - WorkManager 2.9.1's exact manifest.
   - Whether a bare `FOREGROUND_SERVICE` (no type) triggers a Play foreground-service declaration.
   - Whether Photo Picker URIs remove location data.
   - Supabase image `transform` plan gating.
   - The persisted-URI-grant cap.
8. **Group sharing:** the sibling draft's Storage policies only allow a user's own folder, so group
   members can't `createSignedUrl` for files in a group-shared source. That belongs to the backend track.

## Sources

- Package tarballs and source: `scratch/expo-pkgs/x/*` (expo-document-picker 57.0.3, expo-image-picker
  57.0.20, expo-image-manipulator 57.0.21, expo-image-loader 57.0.1, expo-audio 57.0.5, expo-speech
  57.0.3, expo-web-browser 57.0.3, expo-background-task and expo-task-manager 57.0.21, expo-camera
  57.0.6, react-native-document-scanner-plugin 2.0.4). Also android-image-cropper 4.7.0 AAR (Maven
  Central) and media3 1.9.0 manifests (github.com/androidx/media).
- Installed: `node_modules/expo/node_modules/expo-file-system` (57.0.7),
  `@expo/prebuild-config/build/plugins/withDefaultPlugins.js`,
  `expo-modules-core/.../PermissionsService.kt`, `react-native/Libraries/{Network,Blob}`,
  `whatwg-fetch/dist/fetch.umd.js`, `@supabase/storage-js/dist/index.{mjs,d.mts}` 2.117.3,
  `expo-notifications/.../ExpoSchedulingDelegate.kt`.
- [Android photo picker](https://developer.android.com/training/data-storage/shared/photopicker) ·
  [MediaStore.ACTION_IMAGE_CAPTURE](https://developer.android.com/reference/android/provider/MediaStore#ACTION_IMAGE_CAPTURE) ·
  [`<uses-feature>`: permissions that imply features](https://developer.android.com/guide/topics/manifest/uses-feature-element)
- Supabase docs MDX on GitHub (`apps/docs/content/guides/storage/uploads/{file-limits,standard-uploads}.mdx`,
  `security/access-control.mdx`)
- [Claude vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)
- Search summaries (**unverified**):
  [Play Photo and Video Permissions policy](https://support.google.com/googleplay/android-developer/answer/14115180),
  [ML Kit Document Scanner announcement](https://android-developers.googleblog.com/2024/02/ml-kit-document-scanner-api.html)
