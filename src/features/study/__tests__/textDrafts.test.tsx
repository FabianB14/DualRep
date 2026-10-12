import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AppState } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  clearTextDraft,
  countUnsentNotes,
  draftHasText,
  draftToSave,
  parseTextDraft,
  readTextDraft,
  saveTextDraft,
  TEXT_DRAFT_SAVE_MS,
  textDraftKey,
  useDraftSaver,
  type DraftSaver,
} from '../textDrafts';

jest.mock('@/features/cycle/localState', () => {
  const store = new Map<string, unknown>();
  return {
    store,
    deleteLocalState: jest.fn(async (key: string) => {
      store.delete(key);
    }),
    readLocalState: jest.fn(async (key: string) => store.get(key) ?? null),
    readLocalStateByPrefix: jest.fn(async (prefix: string) =>
      [...store.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    ),
    useLocalState: jest.fn(),
    writeLocalState: jest.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
  };
});
const local = jest.requireMock('@/features/cycle/localState') as {
  store: Map<string, unknown>;
  writeLocalState: jest.Mock<(key: string, value: unknown) => Promise<void>>;
  deleteLocalState: jest.Mock<(key: string) => Promise<void>>;
};
const { store } = local;

const PLAN = 'd1000000-0000-4000-8000-000000000001';
const SOURCE = 'a1000000-0000-4000-8000-000000000001';
const draft = { v: 1, planId: PLAN, sourceId: SOURCE, title: '', text: 'Osmosis moves water.', updatedAt: 1 };

beforeEach(() => store.clear());

describe('text drafts', () => {
  it('one key per plan in local_state', () => {
    expect(textDraftKey(PLAN)).toBe(`study-text-draft:${PLAN}`);
  });

  it('reads back only a draft of this plan with a usable source id', () => {
    expect(parseTextDraft(draft, PLAN)).toEqual(draft);
    expect(parseTextDraft(draft, 'd1000000-0000-4000-8000-000000000002')).toBeNull();
    expect(parseTextDraft({ ...draft, sourceId: 'not-a-uuid' }, PLAN)).toBeNull();
    expect(parseTextDraft({ ...draft, v: 2 }, PLAN)).toBeNull();
    expect(parseTextDraft({ ...draft, text: 5 }, PLAN)).toBeNull();
    expect(parseTextDraft({ ...draft, updatedAt: Number.NaN }, PLAN)).toBeNull();
    expect(parseTextDraft(null, PLAN)).toBeNull();
    expect(parseTextDraft('text', PLAN)).toBeNull();
    // A name longer than a source title allows is cut, not refused.
    expect(parseTextDraft({ ...draft, title: 'n'.repeat(250) }, PLAN)?.title).toHaveLength(200);
  });

  it('keeps an over-long draft (the person is still editing) but never more than twice the limit', () => {
    const { v: _v, ...rest } = draft;
    expect(draftToSave({ ...rest, text: 'x'.repeat(21_000) }).text).toHaveLength(21_000);
    expect(draftToSave({ ...rest, text: 'x'.repeat(100_000) }).text).toHaveLength(40_000);
  });

  it('only real words count as unsent notes', () => {
    expect(draftHasText(draft)).toBe(true);
    expect(draftHasText({ text: ' \n\t ' })).toBe(false);
    expect(draftHasText(null)).toBe(false);
  });

  it('counts the plans with unsent notes (what signing out would delete)', async () => {
    const other = 'd1000000-0000-4000-8000-000000000002';
    store.set(textDraftKey(PLAN), draft);
    store.set(textDraftKey(other), { ...draft, planId: other, text: '  ' });
    store.set(textDraftKey('d1000000-0000-4000-8000-000000000003'), { ...draft, planId: other });
    store.set('study-prefs', { answerButtons: 2 });
    await expect(countUnsentNotes()).resolves.toBe(1);
    store.clear();
    await expect(countUnsentNotes()).resolves.toBe(0);
  });

  it('saves, reads back and clears a plan’s draft', async () => {
    const { v: _v, ...rest } = draft;
    await saveTextDraft(rest);
    expect(store.get(textDraftKey(PLAN))).toEqual(draft);
    await expect(readTextDraft(PLAN)).resolves.toEqual(draft);
    await clearTextDraft(PLAN);
    await expect(readTextDraft(PLAN)).resolves.toBeNull();
  });
});

describe('useDraftSaver', () => {
  const savers: DraftSaver[] = [];
  const saver = (): DraftSaver => savers[savers.length - 1];
  let renderer: ReactTestRenderer | null = null;
  const appState: ((state: string) => void)[] = [];
  const goTo = (state: string) => act(() => appState.forEach((listener) => listener(state)));
  const { v: _v, ...rest } = draft;
  const at = (text: string) => ({ ...rest, text });

  function Probe() {
    savers.push(useDraftSaver(PLAN));
    return null;
  }

  beforeEach(() => {
    savers.length = 0;
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    jest.clearAllMocks();
    appState.length = 0;
    (AppState.addEventListener as unknown as jest.Mock<(type: string, listener: (state: string) => void) => { remove(): void }>).mockImplementation(
      (_type, listener) => {
        appState.push(listener);
        return { remove: () => appState.splice(appState.indexOf(listener), 1) };
      },
    );
    act(() => {
      renderer = create(<Probe />);
    });
  });

  afterEach(() => {
    if (renderer) act(() => renderer!.unmount());
    renderer = null;
    jest.useRealTimers();
  });

  const settle = () => act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });

  it('saves within a second of a change, even while changes keep coming', async () => {
    act(() => saver().schedule(at('one')));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(TEXT_DRAFT_SAVE_MS / 2);
    });
    act(() => saver().schedule(at('one two')));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(TEXT_DRAFT_SAVE_MS / 2 - 1);
    });
    expect(local.writeLocalState).not.toHaveBeenCalled();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(local.writeLocalState).toHaveBeenCalledTimes(1);
    expect(store.get(textDraftKey(PLAN))).toMatchObject({ text: 'one two' });
  });

  it('flush saves at once; emptied notes delete the draft', async () => {
    act(() => saver().schedule(at('kept')));
    await act(() => saver().flush());
    expect(store.get(textDraftKey(PLAN))).toMatchObject({ text: 'kept' });
    act(() => saver().schedule(at('  ')));
    await act(() => saver().flush());
    expect(store.has(textDraftKey(PLAN))).toBe(false);
  });

  it('closing the screen saves what is waiting', async () => {
    act(() => saver().schedule(at('last words')));
    act(() => renderer!.unmount());
    renderer = null;
    await settle();
    expect(store.get(textDraftKey(PLAN))).toMatchObject({ text: 'last words' });
  });

  it('leaving the app saves at once, and so does each change while it is away (its timers are paused)', async () => {
    act(() => saver().schedule(at('words before the phone was locked')));
    goTo('background');
    await settle();
    expect(store.get(textDraftKey(PLAN))).toMatchObject({ text: 'words before the phone was locked' });
    // The last words of the dictation the app paused on the way out: no timer to wait for.
    act(() => saver().schedule(at('words before the phone was locked and after')));
    await act(async () => {
      for (let k = 0; k < 5; k += 1) await Promise.resolve();
    });
    expect(store.get(textDraftKey(PLAN))).toMatchObject({ text: 'words before the phone was locked and after' });
    // Back in the app: the usual second's wait again.
    goTo('active');
    act(() => saver().schedule(at('typed later')));
    await act(async () => {
      for (let k = 0; k < 5; k += 1) await Promise.resolve();
    });
    expect(store.get(textDraftKey(PLAN))).toMatchObject({ text: 'words before the phone was locked and after' });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(TEXT_DRAFT_SAVE_MS);
    });
    expect(store.get(textDraftKey(PLAN))).toMatchObject({ text: 'typed later' });
  });

  it('after discard nothing brings the draft back, not even a save already on its way', async () => {
    let finishWrite: () => void = () => undefined;
    local.writeLocalState.mockImplementationOnce(
      (key: string, value: unknown) =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            store.set(key, value);
            resolve();
          };
        }),
    );
    act(() => saver().schedule(at('sent')));
    void saver().flush();
    const discarded = saver().discard();
    act(() => saver().schedule(at('sent and more')));
    // The save is on its way (written after the delete was asked for) when it lands.
    await act(async () => {
      while (local.writeLocalState.mock.calls.length === 0) await Promise.resolve();
    });
    finishWrite();
    await act(() => discarded);
    await act(() => saver().flush());
    act(() => renderer!.unmount());
    renderer = null;
    await settle();
    expect(store.has(textDraftKey(PLAN))).toBe(false);
  });
});
