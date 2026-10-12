import { useStatus } from '@powersync/react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking, View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { waitForUploads } from '@/db/syncCheck';
import { Button, Chip, LoadingView, materialProgressText, Notice, OfflineNotice, Screen, Text, TextField } from '@/components';
import {
  DICTATION_LIMITS,
  dictationLang,
  fitSegment,
  joinSegment,
  languageChoices,
  languageName,
  localeMatches,
  pauseMessage,
  phoneLocale,
  speechServiceName,
} from '@/features/study/dictation';
import { useMinute, usePlan } from '@/features/study/hooks';
import { cleanStudyText, isStudyApiError } from '@/features/study/studyApi';
import { useStudyPrefs } from '@/features/study/studyPrefs';
import { readTextDraft, saveTextDraft, useDraftSaver } from '@/features/study/textDrafts';
import { MicButton } from '@/features/study/ui/MicButton';
import { addMaterial, charCountText, notesTitle, UPLOAD_RULES, uploadContextFor, uploadErrorMessage, validateText } from '@/features/study/upload';
import { useDictation, type Dictation } from '@/features/study/useDictation';
import { newId } from '@/lib/ids';
import { supabase } from '@/lib/supabase';
import { haptic, useTheme } from '@/theme';

/** How long "Add to plan" waits for the phone's own writes (a plan made offline) to upload first. */
const PLAN_UPLOAD_WAIT_MS = 15_000;

/**
 * Speak or type notes for a plan. Android's speech recognition turns what the person says into text
 * as they talk (the words still being heard are greyed below the notes); when paused, the notes can
 * be edited, and typing or pasting works throughout, including with the keyboard's own microphone on
 * a phone with no speech service. Everything is saved on the phone as it changes (works offline);
 * "Add to plan" sends the notes, which needs the internet, and they then become an outline to review
 * and cards like any other material, with no transcription to check (the person has read them).
 */
export default function SpeakNotesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const planId = typeof id === 'string' ? id : null;
  const { plan, isLoading } = usePlan(planId);

  if (!plan || !planId) {
    if (isLoading) return <LoadingView />;
    return (
      <Screen edges={['bottom', 'left', 'right']}>
        <Stack.Screen options={{ title: 'Speak or type notes' }} />
        <Notice title="Plan not found" message="It was deleted, or it isn’t on this phone." />
      </Screen>
    );
  }
  if (!plan.isOwner) {
    return (
      <Screen edges={['bottom', 'left', 'right']}>
        <Stack.Screen options={{ title: 'Speak or type notes' }} />
        <Notice title="Only the plan’s owner can add material" message="You can still study the plan and browse its cards." />
      </Screen>
    );
  }
  return <NotesEditor planId={planId} singleSource={plan.scope === 'single' && plan.sourceCount > 0} />;
}

function NotesEditor({ planId, singleSource }: { planId: string; singleSource: boolean }) {
  const { user } = useAuth();
  const { space } = useTheme();
  const status = useStatus();
  const online = status.connected || status.connecting;
  const now = useMinute();
  const { prefs, save: savePrefs } = useStudyPrefs();
  const phone = useMemo(() => phoneLocale(), []);
  const lang = dictationLang(prefs.dictationLang, phone);
  const langName = languageName(lang);
  const dictation = useDictation({ lang });
  const { text, setText, live, overflow, setOverflow } = dictation;
  const listening = dictation.status !== 'off';
  const drafts = useDraftSaver(planId);

  const [title, setTitle] = useState('');
  // The source id these notes are added under; null until the saved draft (if any) has been read.
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [picking, setPicking] = useState(false);
  const [downloadNote, setDownloadNote] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  // "Add to plan" is running, including while it waits for the last words (before `working` is set).
  const submitting = useRef(false);

  // Unsent notes from before come back (and keep their source id, so a retry is the same submit).
  useEffect(() => {
    let active = true;
    readTextDraft(planId)
      .catch(() => null)
      .then((draft) => {
        if (!active) return;
        if (draft) {
          // The waiting words first: notes saved empty take them (they are the next set now).
          setOverflow(draft.overflow ?? '');
          setText(draft.text);
          setTitle(draft.title);
        }
        setSourceId(draft?.sourceId ?? newId());
      });
    return () => {
      active = false;
    };
  }, [planId, setText, setOverflow]);

  // Every change is saved on the phone (at most a second later); words still being heard are kept
  // with them, so leaving the screen mid-sentence loses nothing (after the words that didn't fit, if
  // any, as the hook will place them).
  useEffect(() => {
    if (sourceId === null) return;
    const words = overflow ? { text, overflow: joinSegment(overflow, live) } : fitSegment(text, live);
    drafts.schedule({ planId, sourceId, title, ...words, updatedAt: Date.now() });
  }, [drafts, planId, sourceId, text, live, overflow, title]);
  // A pause (or a stop by the phone) saves at once.
  useEffect(() => {
    if (dictation.status === 'off') void drafts.flush();
  }, [dictation.status, drafts]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving the screen stops an add in progress (the notes stay on the phone).
      abort.current?.abort();
    };
  }, []);

  if (sourceId === null) return <LoadingView />;

  const count = cleanStudyText(text).length;
  const over = count > UPLOAD_RULES.maxTextChars;
  const probe = dictation.probe;
  const engine = probe?.engine ?? null;
  const canListen = engine?.kind === 'on-device' || engine?.kind === 'online';
  const offlineReady = (tag: string) => (probe ? localeMatches(probe.installed, tag) : false);

  const submit = async () => {
    // One at a time: a second tap while the last words come in would send the notes twice at once.
    if (!user || submitting.current) return;
    submitting.current = true;
    try {
      await addNotes(user.id);
    } finally {
      submitting.current = false;
    }
  };

  const addNotes = async (userId: string) => {
    setError(null);
    // Listening: wait for the last words first.
    const words = dictation.status === 'off' ? text : await dictation.finish();
    try {
      validateText(words);
    } catch (problem) {
      setError(uploadErrorMessage(problem));
      haptic('error');
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setWorking(true);
    await drafts.flush();
    try {
      await addMaterial(
        uploadContextFor(supabase),
        { kind: 'text', text: words, title },
        {
          userId,
          planId,
          sourceId,
          signal: controller.signal,
          // A plan made offline must reach the server before the study function can find it.
          beforeSubmit: () => waitForUploads(PLAN_UPLOAD_WAIT_MS),
          onProgress: (update) => setProgress(materialProgressText(update, 'text')),
        },
      );
      await drafts.discard();
      // Words that didn't fit in these notes start the next set: the plan shows them as Unsent notes.
      const next = dictation.takeOverflow();
      if (next) await saveTextDraft({ planId, sourceId: newId(), title: '', text: next, updatedAt: Date.now() }).catch(() => undefined);
      if (!mounted.current) return;
      haptic('success');
      router.dismissTo({ pathname: '/plans/[id]', params: { id: planId } });
    } catch (problem) {
      if (!mounted.current) return;
      if (isStudyApiError(problem) && problem.kind === 'conflict') {
        // These notes changed after an earlier attempt reached the server: the next tap adds this
        // version as new notes (the earlier one stays). The draft is saved with the new id.
        setSourceId(newId());
      }
      setError(uploadErrorMessage(problem));
      haptic('error');
    } finally {
      abort.current = null;
      if (mounted.current) {
        setWorking(false);
        setProgress(null);
      }
    }
  };

  const clear = () => {
    Alert.alert('Clear these notes?', 'What you said and typed here is deleted from this phone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () => {
          // The waiting words first, or the emptied notes would take them.
          setOverflow('');
          setText('');
          setTitle('');
          setError(null);
          // What comes next is new notes: if an attempt to add the cleared ones reached the server
          // (its answer lost), they keep their id, and these are not taken for an edit of them.
          setSourceId(newId());
        },
      },
    ]);
  };

  const download = async () => {
    setDownloadNote(null);
    const outcome = await dictation.downloadOffline();
    if (!mounted.current) return;
    setDownloadNote(
      outcome === 'done'
        ? `${langName} is on this phone now. Speech stays on the phone.`
        : outcome === 'scheduled'
          ? `${langName} will download later, maybe once you’re on Wi-Fi. Until then, Google’s online service is used.`
          : outcome === 'dialog'
            ? 'Follow the steps on screen, then come back here.'
            : 'The download couldn’t start. Try again later.',
    );
  };

  const choose = (tag: string) => {
    setPicking(false);
    // The phone's own language is stored as "the phone's language", so it follows a change there.
    savePrefs({ dictationLang: tag === dictationLang(null, phone) ? null : tag }).catch(() => undefined);
  };

  const footer = (
    <>
      {working && progress ? (
        <Text tone="secondary" align="center" accessibilityLiveRegion="polite">
          {progress}
        </Text>
      ) : null}
      <Button
        label="Add to plan"
        size="comfortable"
        loading={working}
        onPress={() => void submit()}
        accessibilityHint="Needs the internet. Until then the notes stay on this phone."
      />
    </>
  );

  return (
    <Screen edges={['bottom', 'left', 'right']} footer={footer}>
      <Stack.Screen options={{ title: 'Speak or type notes' }} />
      {!online ? <OfflineNotice action="Adding the notes to the plan" /> : null}
      {singleSource ? (
        <Notice message="This plan is set to one source, so you study its newest material. To review everything together, make it a growing course in Plan settings." />
      ) : null}

      <Text tone="secondary">Say or type what you learned. It counts as one source this month, and you’ll review the outline before cards are made.</Text>

      <EngineLine dictation={dictation} langName={langName} onDownload={() => void download()} />
      {downloadNote ? <Text tone="secondary">{downloadNote}</Text> : null}

      {engine && engine.kind !== 'unavailable' ? (
        <View style={{ gap: space[2] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space[2] }}>
            <Text style={{ flexShrink: 1 }}>{`Language: ${langName}${offlineReady(lang) ? ' (works offline)' : ''}`}</Text>
            <Button
              label={picking ? 'Done' : 'Change'}
              variant="ghost"
              fullWidth={false}
              disabled={listening || working}
              accessibilityLabel={picking ? 'Close the language list' : `Change the language, now ${langName}`}
              onPress={() => setPicking((open) => !open)}
            />
          </View>
          {picking ? (
            <View accessibilityRole="radiogroup" accessibilityLabel="Language" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              {languageChoices(phone, probe?.supported ?? []).map((tag) => (
                <Chip
                  key={tag}
                  role="radio"
                  selected={tag === lang}
                  label={offlineReady(tag) ? `${languageName(tag)} · offline` : languageName(tag)}
                  onPress={() => choose(tag)}
                />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      {canListen ? (
        <View style={{ gap: space[2] }}>
          <MicButton
            status={dictation.status}
            level={dictation.level}
            disabled={working}
            onPress={() => {
              setStarted(true);
              void dictation.toggle();
            }}
          />
          <StatusLine dictation={dictation} started={started} langName={langName} over={over} />
        </View>
      ) : null}

      {dictation.permission === 'blocked' && canListen ? (
        <Notice
          tone="warning"
          title="Microphone access is off"
          message="To speak your notes, allow the microphone for DualRep in system settings. You can still type."
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

      <View style={{ gap: space[2] }}>
        <TextField
          label="Your notes"
          value={text}
          onChangeText={setText}
          multiline
          minLines={6}
          maxLines={14}
          readOnly={listening || working}
          // While listening, the newest words stay in view.
          selection={listening ? { start: text.length, end: text.length } : undefined}
          placeholder="What did you learn? Say it or type it."
          autoCapitalize="sentences"
          autoCorrect
          error={over ? `${charCountText(count)} of ${charCountText(UPLOAD_RULES.maxTextChars)} characters. Shorten the notes, or add the rest as another set of notes.` : null}
          hint={
            listening
              ? 'You can edit the notes once you pause.'
              : 'Saved on this phone as you go. Check the words before adding. Your keyboard’s microphone works here too.'
          }
        />
        {live ? (
          <Text tone="secondary" style={{ fontStyle: 'italic' }} accessibilityLabel={`Still hearing: ${live}`}>
            {`…${live}`}
          </Text>
        ) : null}
        {overflow ? (
          <Text tone="secondary" accessibilityLiveRegion="polite">
            {`Didn’t fit in these notes, so they’ll start your next set: “${overflow}”`}
          </Text>
        ) : null}
        {!over && count >= DICTATION_LIMITS.counterFromChars ? (
          <Text variant="caption" tone="secondary">
            {`${charCountText(count)} of ${charCountText(UPLOAD_RULES.maxTextChars)} characters`}
          </Text>
        ) : null}
      </View>

      <TextField
        label="Name (optional)"
        value={title}
        onChangeText={setTitle}
        placeholder={notesTitle(now)}
        maxLength={UPLOAD_RULES.maxTitleChars}
        editable={!working}
        hint="Shown on the plan and next to each card."
      />

      {(text.trim() !== '' || overflow !== '') && !listening && !working ? <Button label="Clear the notes" variant="ghost" onPress={clear} /> : null}

      {error ? <Notice tone="danger" title="Not added" message={error} accessibilityLiveRegion="polite" /> : null}
    </Screen>
  );
}

/** Where the speech is turned into text, in plain words, or what to do when it can't be. */
function EngineLine({ dictation, langName, onDownload }: { dictation: Dictation; langName: string; onDownload(): void }) {
  const engine = dictation.probe?.engine ?? null;
  const download = (
    <Button label={`Download ${langName} for offline use`} variant="ghost" disabled={dictation.status !== 'off'} onPress={onDownload} />
  );
  if (!engine) return <Text tone="secondary">Checking this phone’s speech-to-text…</Text>;
  switch (engine.kind) {
    case 'on-device':
      return <Text tone="secondary">Works on this phone, offline: what you say isn’t sent anywhere to be turned into text.</Text>;
    case 'online':
      return (
        <View>
          <Text tone="secondary">
            Uses Google’s online speech service: what you say is sent to Google to be turned into text, so it needs the internet.
          </Text>
          {engine.canDownload ? download : null}
        </View>
      );
    case 'download-only':
      return (
        <Notice
          title="Speech-to-text needs a download"
          message={`This phone can turn ${langName} speech into text once the language is downloaded. Until then, type or use your keyboard’s microphone.`}
          action={download}
        />
      );
    case 'unavailable':
      return (
        <Notice
          title="No speech-to-text on this phone"
          message="Type or paste your notes below, or use your keyboard’s microphone."
        />
      );
  }
}

/** One plain line about the microphone, read out by screen readers whenever it changes. */
function StatusLine({ dictation, started, langName, over }: { dictation: Dictation; started: boolean; langName: string; over: boolean }) {
  const line = (() => {
    switch (dictation.status) {
      case 'starting':
        return 'Starting…';
      case 'listening':
        return `Listening for ${langName}. Tap Pause when you’re done.`;
      case 'stopping':
        return 'Finishing the last words…';
      case 'off':
        if (dictation.pauseReason === 'permission') {
          return dictation.permission === 'blocked'
            ? 'DualRep can’t use the microphone. You can still type.'
            : 'DualRep needs the microphone to hear you. Tap Start speaking to be asked again, or type.';
        }
        if (dictation.pauseReason || started) {
          // The online engine is the phone's default speech service; the on-device one may be another app.
          const service = dictation.probe?.engine.kind === 'online' ? speechServiceName(dictation.probe.service) : null;
          return pauseMessage(dictation.pauseReason, langName, { over, service });
        }
        return 'Tap Start speaking and talk. DualRep listens only while the mic is on, and keeps no recording.';
    }
  })();
  return (
    <Text tone="secondary" align="center" accessibilityLiveRegion="polite">
      {line}
    </Text>
  );
}
