import { useStatus } from '@powersync/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Linking, View } from 'react-native';

import { Button, Card, LoadingView, Notice, OfflineNotice, Screen, Text, TextField } from '@/components';
import { usePlan, useSourceFiles, useSourceProgress } from '@/features/study/hooks';
import { confirmTranscripts, studyErrorMessage } from '@/features/study/studyApi';
import type { SourceFileRow } from '@/features/study/studyQueries';
import { markTranscriptsConfirmed, saveTranscript, STUDY_LIMITS } from '@/features/study/studyRepo';
import { BUCKET } from '@/features/study/upload';
import { supabase } from '@/lib/supabase';
import { haptic, useTheme } from '@/theme';

/** How long a photo's signed address stays valid (seconds). */
const SIGNED_URL_SECONDS = 600;

/**
 * Check the transcription of a set of handwritten notes: each page's photo next to the text read
 * from it, editable. Corrections are kept on the phone as they are made (offline too); "Confirm"
 * sends the final text to the study service, which then makes the outline. Nothing becomes cards
 * before this, so a misread word never turns into a wrong card.
 */
export default function CheckTranscriptionScreen() {
  const params = useLocalSearchParams<{ id: string; sourceId: string }>();
  const planId = typeof params.id === 'string' ? params.id : null;
  const sourceId = typeof params.sourceId === 'string' ? params.sourceId : null;
  const { space } = useTheme();
  const status = useStatus();
  const online = status.connected || status.connecting;
  const { plan } = usePlan(planId);
  const { files, isLoading } = useSourceFiles(sourceId);
  const progress = useSourceProgress(planId);
  const source = progress.sources.find((entry) => entry.sourceId === sourceId) ?? null;
  // What the person typed, by file id; a file not here shows its stored text.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!planId || !sourceId || (files.length === 0 && !isLoading)) {
    return (
      <Screen edges={['bottom', 'left', 'right']}>
        <Notice title="Nothing to check" message="These notes aren’t on this phone yet. Go back to the plan and try again in a moment." />
      </Screen>
    );
  }
  if (isLoading && files.length === 0) return <LoadingView />;

  const step = source?.step.step ?? null;
  const allConfirmed = files.some((file) => file.confirmed === 1) && files.every((file) => file.confirmed === 1 || file.transcript === null);
  const canConfirm = step === 'check_transcripts' && plan?.isOwner !== false;
  const stillReading = step === 'reading';
  const textOf = (file: SourceFileRow) => edits[file.id] ?? file.transcript ?? '';

  const keepEdit = (file: SourceFileRow) => {
    const text = edits[file.id];
    if (text === undefined || text === (file.transcript ?? '')) return;
    saveTranscript(file.id, text).catch(() => undefined);
  };

  const confirm = async () => {
    if (busy) return;
    const readable = files.filter((file) => file.transcript !== null || edits[file.id] !== undefined);
    const tooLong = readable.find((file) => textOf(file).length > STUDY_LIMITS.transcript);
    if (tooLong) {
      setError(`Page ${tooLong.page ?? ''} is longer than ${STUDY_LIMITS.transcript.toLocaleString()} characters. Shorten it.`);
      haptic('error');
      return;
    }
    setBusy(true);
    setError(null);
    const final = readable.map((file) => ({ id: file.id, transcript: textOf(file) }));
    try {
      await confirmTranscripts(supabase, { plan_id: planId, source_id: sourceId, files: final });
      await markTranscriptsConfirmed(final).catch(() => undefined);
      haptic('success');
      router.back();
    } catch (problem) {
      setError(studyErrorMessage(problem));
      haptic('error');
      setBusy(false);
    }
  };

  const footer = canConfirm ? (
    <Button
      label="Confirm"
      size="comfortable"
      loading={busy}
      accessibilityHint="Saves your corrections and makes the outline. Needs the internet."
      onPress={() => void confirm()}
    />
  ) : undefined;

  return (
    <Screen edges={['bottom', 'left', 'right']} footer={footer}>
      <View style={{ gap: space[1] }}>
        <Text variant="title">{source?.title || 'Your notes'}</Text>
        <Text tone="secondary">
          {canConfirm
            ? 'Fix anything that was misread, then confirm. Cards are made only from this text.'
            : stillReading
              ? 'Some pages are still being read. You can start correcting the ones that are done.'
              : allConfirmed
                ? 'Confirmed. The outline is made from this text.'
                : 'Here is the text read from each page.'}
        </Text>
      </View>

      {!online && canConfirm ? <OfflineNotice action="Confirming the text" /> : null}
      {error ? <Notice tone="danger" title="Not confirmed" message={error} accessibilityLiveRegion="polite" /> : null}

      {files.map((file, index) => {
        const page = file.page ?? index + 1;
        const locked = file.confirmed === 1 || plan?.isOwner === false;
        return (
          <Card key={file.id}>
            <Text variant="subtitle" accessibilityRole="header">
              Page {page}
            </Text>
            <PagePhoto path={file.storage_path} page={page} online={online} />
            {file.transcript === null && edits[file.id] === undefined ? (
              <Text tone="secondary">{stillReading ? 'Still being read…' : 'Nothing could be read from this page.'}</Text>
            ) : (
              <TextField
                label={`Text of page ${page}`}
                value={textOf(file)}
                onChangeText={(text) => setEdits((current) => ({ ...current, [file.id]: text }))}
                onBlur={() => keepEdit(file)}
                multiline
                editable={!locked && !busy}
                maxLength={STUDY_LIMITS.transcript}
              />
            )}
          </Card>
        );
      })}
    </Screen>
  );
}

/**
 * A page's photo, through a short-lived signed address (the bucket is private). It needs the
 * internet; without it the text can still be checked.
 */
function PagePhoto({ path, page, online }: { path: string | null; page: number; online: boolean }) {
  const { colors, radius, space } = useTheme();
  const [loaded, setLoaded] = useState<{ path: string; url: string } | null>(null);
  // A failure counts for the connection state it happened in: when that changes, the photo is tried
  // again (so one that failed offline loads once the phone is back online).
  const [failure, setFailure] = useState<{ path: string | null; online: boolean } | null>(null);
  const url = loaded !== null && loaded.path === path ? loaded.url : null;
  const failed = !path || (failure !== null && failure.path === path && failure.online === online);

  useEffect(() => {
    if (!path || !supabase || url) return;
    let active = true;
    supabase.storage
      .from(BUCKET)
      .createSignedUrl(path, SIGNED_URL_SECONDS)
      .then(({ data, error }) => {
        if (!active) return;
        if (error || !data?.signedUrl) setFailure({ path, online });
        else setLoaded({ path, url: data.signedUrl });
      })
      .catch(() => {
        if (active) setFailure({ path, online });
      });
    return () => {
      active = false;
    };
  }, [path, url, online]);

  const frame = {
    width: '100%' as const,
    aspectRatio: 3 / 4,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    overflow: 'hidden' as const,
  };

  if (failed) {
    return (
      <View style={[frame, { aspectRatio: undefined, padding: space[4] }]}>
        <Text tone="secondary" align="center">
          {online ? 'The photo couldn’t be loaded.' : 'The photo shows when you’re online. You can still check the text.'}
        </Text>
      </View>
    );
  }
  if (!url) {
    return (
      <View style={frame} accessible accessibilityLabel={`Loading the photo of page ${page}`}>
        <ActivityIndicator color={colors.mind.solid} />
      </View>
    );
  }
  return (
    <View style={{ gap: space[2] }}>
      <View style={frame}>
        <Image
          source={{ uri: url }}
          style={{ width: '100%', height: '100%' }}
          resizeMode="contain"
          accessible
          accessibilityLabel={`Photo of page ${page}`}
          onError={() => setFailure({ path, online })}
        />
      </View>
      <Button
        label="Open the photo full size"
        variant="ghost"
        accessibilityLabel={`Open the photo of page ${page} full size`}
        onPress={() => {
          Linking.openURL(url).catch(() => undefined);
        }}
      />
    </View>
  );
}
