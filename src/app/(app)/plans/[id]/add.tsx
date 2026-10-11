import { useStatus } from '@powersync/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Image, Linking, View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { waitForUploads } from '@/db/syncCheck';
import {
  Button,
  Card,
  ListGroup,
  ListRow,
  LoadingView,
  materialProgressText,
  Notice,
  OfflineNotice,
  ReorderButtons,
  reorderActions,
  Screen,
  Section,
  SegmentedControl,
  Text,
  TextField,
} from '@/components';
import { useMinute, usePlan } from '@/features/study/hooks';
import { isStudyApiError } from '@/features/study/studyApi';
import {
  addMaterial,
  canTakePhoto,
  documentTitle,
  linkTitle,
  notesTitle,
  pickDocuments,
  pickPhotos,
  recoverPendingPhotos,
  takePhoto,
  UPLOAD_RULES,
  uploadContextFor,
  UploadError,
  uploadErrorMessage,
  validateDocument,
  validateLink,
  validatePhotos,
  type AddMaterialProgress,
  type PickedDocument,
  type PickedPhoto,
} from '@/features/study/upload';
import { newId } from '@/lib/ids';
import { supabase } from '@/lib/supabase';
import { haptic, useTheme } from '@/theme';

type Mode = 'file' | 'photos' | 'link';

const MODES: readonly { value: Mode; label: string; accessibilityLabel: string }[] = [
  { value: 'file', label: 'File', accessibilityLabel: 'A PDF or Word file' },
  { value: 'photos', label: 'Photos', accessibilityLabel: 'Photos of handwritten notes' },
  { value: 'link', label: 'Link', accessibilityLabel: 'A web page' },
];

/** A picked document and the source id it keeps across retries (so a retry overwrites, not duplicates). */
type PendingDocument = { doc: PickedDocument; sourceId: string };

const MIB = 1024 * 1024;
/** How long "Add to plan" waits for the phone's own writes (a plan made offline) to upload first. */
const PLAN_UPLOAD_WAIT_MS = 15_000;

function sizeText(bytes: number | null): string | undefined {
  if (bytes === null) return undefined;
  return bytes >= MIB ? `${(bytes / MIB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Add material to a plan: a PDF or Word file, photos of handwritten notes (from the gallery, or the
 * camera on Android 10 and later), or a web page. It is uploaded and handed to the study service,
 * which needs the internet; the screen says so up front when the phone seems offline, and a failed
 * attempt keeps everything picked so "Add to plan" can simply be tapped again.
 */
export default function AddMaterialScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const planId = typeof id === 'string' ? id : null;
  const { user } = useAuth();
  const { space, radius, colors } = useTheme();
  const status = useStatus();
  const online = status.connected || status.connecting;
  const { plan, isLoading } = usePlan(planId);
  const now = useMinute();

  const [mode, setMode] = useState<Mode>('file');
  const [docs, setDocs] = useState<PendingDocument[]>([]);
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  // One source id per piece of material until it is added: a retry reuses it.
  const [ids] = useState(() => ({ photos: newId(), link: newId() }));
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraDenied, setCameraDenied] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const cameraOk = canTakePhoto();

  const addPhotos = (picked: PickedPhoto[]) => {
    if (picked.length === 0) return;
    if (photos.length + picked.length > UPLOAD_RULES.maxPhotos) {
      setError(`Up to ${UPLOAD_RULES.maxPhotos} photos per set of notes. Add the rest as another set.`);
    }
    setPhotos((current) => [...current, ...picked].slice(0, UPLOAD_RULES.maxPhotos));
  };

  // A photo taken while Android stopped the app (the camera app was in front) comes back here.
  useEffect(() => {
    let active = true;
    recoverPendingPhotos()
      .then((recovered) => {
        if (!active || recovered.length === 0) return;
        setMode('photos');
        setPhotos((current) => [...current, ...recovered].slice(0, UPLOAD_RULES.maxPhotos));
      })
      .catch(() => undefined);
    return () => {
      active = false;
      // Leaving the screen stops an upload in progress (nothing half-done is submitted).
      abort.current?.abort();
    };
  }, []);

  if (!plan || !planId) {
    if (isLoading) return <LoadingView />;
    return (
      <Screen edges={['bottom', 'left', 'right']}>
        <Notice title="Plan not found" message="It was deleted, or it isn’t on this phone." />
      </Screen>
    );
  }
  if (!plan.isOwner) {
    return (
      <Screen edges={['bottom', 'left', 'right']}>
        <Notice title="Only the plan’s owner can add material" message="You can still study the plan and browse its cards." />
      </Screen>
    );
  }

  const pickFiles = async () => {
    setError(null);
    let picked: PickedDocument[];
    try {
      picked = await pickDocuments();
    } catch {
      setError('The file picker couldn’t open. Try again.');
      return;
    }
    const problems: string[] = [];
    const accepted: PendingDocument[] = [];
    for (const doc of picked) {
      try {
        validateDocument(doc);
        if (!docs.some((item) => item.doc.uri === doc.uri)) accepted.push({ doc, sourceId: newId() });
      } catch (problem) {
        problems.push(uploadErrorMessage(problem));
      }
    }
    setDocs((current) => [...current, ...accepted]);
    if (problems.length > 0) {
      setError(problems.join('\n'));
      haptic('warning');
    }
  };

  const pickFromGallery = async () => {
    setError(null);
    const room = UPLOAD_RULES.maxPhotos - photos.length;
    if (room <= 0) {
      setError(`Up to ${UPLOAD_RULES.maxPhotos} photos per set of notes. Add the rest as another set.`);
      return;
    }
    try {
      addPhotos(await pickPhotos(room));
    } catch {
      setError('The photo picker couldn’t open. Try again.');
    }
  };

  const shoot = async () => {
    setError(null);
    setCameraDenied(false);
    try {
      const result = await takePhoto();
      if (result === 'denied') setCameraDenied(true);
      else if (result) addPhotos([result]);
    } catch {
      setError('The camera couldn’t open. Choose photos from the gallery instead.');
    }
  };

  const movePhoto = (index: number, delta: -1 | 1) => {
    setPhotos((current) => {
      const to = index + delta;
      if (to < 0 || to >= current.length) return current;
      const next = [...current];
      const [photo] = next.splice(index, 1);
      next.splice(to, 0, photo);
      return next;
    });
  };

  const removePhoto = (index: number) => setPhotos((current) => current.filter((_, i) => i !== index));

  const kindOfProgress = mode === 'file' ? 'document' : mode === 'photos' ? 'notes' : 'link';
  const report = (prefix: string) => (update: AddMaterialProgress) => setProgress(`${prefix}${materialProgressText(update, kindOfProgress)}`);

  const submit = async () => {
    if (!user || working) return;
    setError(null);
    setCameraDenied(false);
    try {
      if (mode === 'file' && docs.length === 0) throw new UploadError('no_files', 'Choose a PDF or Word file first.');
      if (mode === 'photos') validatePhotos(photos);
      if (mode === 'link') validateLink(url);
    } catch (problem) {
      setError(uploadErrorMessage(problem));
      haptic('error');
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    const context = uploadContextFor(supabase);
    // A plan made offline must reach the server before the study function can find it.
    const common = { userId: user.id, planId, signal: controller.signal, beforeSubmit: () => waitForUploads(PLAN_UPLOAD_WAIT_MS) };
    setWorking(true);
    try {
      if (mode === 'file') {
        const batch = [...docs];
        for (let i = 0; i < batch.length; i += 1) {
          const item = batch[i];
          const target = validateDocument(item.doc);
          await addMaterial(
            context,
            { kind: target.kind, document: item.doc, title: batch.length === 1 ? title : null },
            { ...common, sourceId: item.sourceId, onProgress: report(batch.length > 1 ? `File ${i + 1} of ${batch.length}: ` : '') },
          );
          setDocs((current) => current.filter((entry) => entry.sourceId !== item.sourceId));
        }
      } else if (mode === 'photos') {
        await addMaterial(context, { kind: 'notes', photos, title }, { ...common, sourceId: ids.photos, onProgress: report('') });
      } else {
        await addMaterial(context, { kind: 'link', url, title }, { ...common, sourceId: ids.link, onProgress: report('') });
      }
      haptic('success');
      router.back();
    } catch (problem) {
      if (isStudyApiError(problem) && problem.kind === 'cancelled') setError('Stopped. Nothing was added; tap Add to plan to start again.');
      else setError(uploadErrorMessage(problem));
      haptic('error');
    } finally {
      abort.current = null;
      setWorking(false);
      setProgress(null);
    }
  };

  const titlePlaceholder =
    mode === 'file'
      ? docs.length === 1
        ? documentTitle(docs[0].doc.name)
        : 'The file’s name'
      : mode === 'photos'
        ? notesTitle(now)
        : url.trim().startsWith('https://')
          ? linkTitle(url.trim())
          : 'The page’s address';
  const showTitle = mode !== 'file' || docs.length <= 1;

  const footer = (
    <>
      {working && progress ? (
        <Text tone="secondary" align="center" accessibilityLiveRegion="polite">
          {progress}
        </Text>
      ) : null}
      <Button label="Add to plan" size="comfortable" loading={working} onPress={() => void submit()} accessibilityHint="Needs the internet" />
      {working ? <Button label="Stop" variant="ghost" onPress={() => abort.current?.abort()} /> : null}
    </>
  );

  return (
    <Screen edges={['bottom', 'left', 'right']} footer={footer}>
      {!online ? <OfflineNotice action="Adding material" /> : null}
      {plan.scope === 'single' && plan.sourceCount > 0 ? (
        <Notice
          message="This plan is set to one source, so you study its newest material. To review everything together, make it a growing course in Plan settings."
        />
      ) : null}

      <SegmentedControl<Mode> label="What are you adding?" value={mode} options={MODES} disabled={working} onChange={setMode} />

      {mode === 'file' ? (
        <Section title="PDF or Word file" description={`Up to ${UPLOAD_RULES.maxFileBytes / MIB} MB each. Each file becomes its own source.`}>
          {docs.length > 0 ? (
            <ListGroup>
              {docs.map((item) => (
                <ListRow
                  key={item.sourceId}
                  title={item.doc.name || 'Document'}
                  subtitle={sizeText(item.doc.size)}
                  trailing={
                    <Button
                      label="Remove"
                      variant="ghost"
                      fullWidth={false}
                      disabled={working}
                      accessibilityLabel={`Remove ${item.doc.name || 'this file'}`}
                      onPress={() => setDocs((current) => current.filter((entry) => entry.sourceId !== item.sourceId))}
                    />
                  }
                />
              ))}
            </ListGroup>
          ) : null}
          <Button label={docs.length > 0 ? 'Choose another file' : 'Choose a file'} variant="secondary" disabled={working} onPress={() => void pickFiles()} />
        </Section>
      ) : null}

      {mode === 'photos' ? (
        <Section
          title="Photos of your notes"
          description={`One photo per page, in page order, up to ${UPLOAD_RULES.maxPhotos}. You’ll check the transcription before cards are made.`}
        >
          {photos.map((photo, index) => {
            const label = `Page ${index + 1}`;
            return (
              <Card key={`${photo.uri}:${index}`}>
                <View
                  accessible
                  accessibilityLabel={`${label} of ${photos.length}`}
                  accessibilityActions={reorderActions(index, photos.length)}
                  onAccessibilityAction={(event) => movePhoto(index, event.nativeEvent.actionName === 'moveUp' ? -1 : 1)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}
                >
                  <Image
                    source={{ uri: photo.uri }}
                    style={{ width: 64, height: 64, borderRadius: radius.sm, backgroundColor: colors.surfaceMuted }}
                    resizeMode="cover"
                  />
                  <Text variant="label">{label}</Text>
                </View>
                <ReorderButtons
                  itemLabel={label}
                  index={index}
                  count={photos.length}
                  disabled={working}
                  onMove={(delta) => movePhoto(index, delta)}
                  extra={{ label: 'Remove', onPress: () => removePhoto(index) }}
                />
              </Card>
            );
          })}
          <View style={{ gap: space[2] }}>
            <Button
              label={photos.length > 0 ? 'Add photos from the gallery' : 'Choose photos from the gallery'}
              variant="secondary"
              disabled={working || photos.length >= UPLOAD_RULES.maxPhotos}
              onPress={() => void pickFromGallery()}
            />
            {cameraOk ? (
              <Button
                label="Take a photo"
                variant="secondary"
                disabled={working || photos.length >= UPLOAD_RULES.maxPhotos}
                accessibilityHint="Asks for the camera the first time"
                onPress={() => void shoot()}
              />
            ) : null}
          </View>
          {cameraDenied ? (
            <Notice
              tone="warning"
              title="Camera access is off"
              message="Allow the camera for DualRep in system settings, or choose photos from the gallery."
              action={
                <Button
                  label="Open system settings"
                  variant="secondary"
                  onPress={() => {
                    Linking.openSettings().catch(() => undefined);
                  }}
                />
              }
            />
          ) : null}
        </Section>
      ) : null}

      {mode === 'link' ? (
        <TextField
          label="Web address"
          value={url}
          onChangeText={setUrl}
          placeholder="https://"
          keyboardType="url"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!working}
          hint="A public page, such as an article or lecture notes. Pages behind a sign-in can’t be read."
        />
      ) : null}

      {showTitle ? (
        <TextField
          label="Name (optional)"
          value={title}
          onChangeText={setTitle}
          placeholder={titlePlaceholder}
          maxLength={UPLOAD_RULES.maxTitleChars}
          editable={!working}
          hint="Shown on the plan and next to each card’s page."
        />
      ) : null}

      {error ? <Notice tone="danger" title="Not added" message={error} accessibilityLiveRegion="polite" /> : null}
    </Screen>
  );
}
