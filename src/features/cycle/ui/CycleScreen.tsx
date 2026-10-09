import { useCallback, useState } from 'react';

import { LoadingView } from '@/components';
import { useNotificationPermission } from '@/features/timer/useNotificationPermission';

import { useCycle } from '../useCycle';
import type { WindowFrame } from './FocusDial';
import { FinishSummary } from './FinishSummary';
import { FocusView } from './FocusView';
import { endMorph, NO_HANDOFF, trackHandoff, type HandoffTrack } from './handoff';
import { MoveBlock } from './MoveBlock';
import { ReturnView } from './ReturnView';
import { StartPanel } from './StartPanel';
import { leaveCycleScreen } from './TopBar';

export type CycleScreenProps = {
  /** What the start panel offers when no cycle runs: a study block, or "Just train". */
  mode: 'study' | 'move';
};

function sameFrame(a: WindowFrame | null, b: WindowFrame): boolean {
  return a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * The cycle screen: study → move → study (docs/EXECUTION_PLAN.md "Product loop"). It shows whatever
 * phase the saved cycle is in, so it is right after an app restart in any phase (the state comes
 * from local_state through useCycle):
 * - idle: the start panel, or the summary of the cycle that just finished;
 * - focus: the timer ring;
 * - move: the exercise card and the set logger; when the focus block ends on screen, the ring
 *   morphs into the first card with no tap (see handoff.ts for when, HandoffMorph for how);
 * - return: the countdown into the next focus block.
 * useCycle performs the writes, the notifications and the haptics; this screen only renders and
 * forwards taps.
 */
export function CycleScreen({ mode }: CycleScreenProps) {
  const cycle = useCycle();
  const notifications = useNotificationPermission();
  const [handoff, setHandoff] = useState<HandoffTrack>(NO_HANDOFF);
  const [ringFrame, setRingFrame] = useState<WindowFrame | null>(null);
  const { state, now, error } = cycle;

  // Follows the cycle render by render (same object when nothing changed), so the morph is decided in
  // the very render that first shows the move block, before anything is drawn.
  const tracked = trackHandoff(handoff, state, now);
  if (tracked !== handoff) setHandoff(tracked);

  const onRingFrame = useCallback((frame: WindowFrame) => {
    setRingFrame((current) => (sameFrame(current, frame) ? current : frame));
  }, []);

  if (!state) return <LoadingView />;

  switch (state.phase) {
    case 'idle':
      return state.summary ? (
        <FinishSummary summary={state.summary} onDismiss={cycle.dismissSummary} onLeave={leaveCycleScreen} />
      ) : (
        <StartPanel
          mode={mode}
          permission={notifications.permission}
          requestPermission={notifications.request}
          onStart={cycle.start}
          onStartMove={cycle.startMoveOnly}
          error={error}
        />
      );
    case 'focus':
      return (
        <FocusView
          key={state.blockId}
          state={state}
          now={now}
          permission={notifications.permission}
          error={error}
          onPause={cycle.pause}
          onResume={cycle.resume}
          onEndBlock={cycle.endBlock}
          onFinish={cycle.finish}
          onRingFrame={onRingFrame}
        />
      );
    case 'move': {
      const { workoutId } = state;
      return (
        <MoveBlock
          key={workoutId}
          state={state}
          now={now}
          unit={cycle.unit}
          error={error}
          handoff={tracked.morph === workoutId}
          ringFrame={ringFrame}
          onHandoffDone={() => setHandoff((current) => endMorph(current, workoutId))}
          actions={cycle}
        />
      );
    }
    case 'return':
      return (
        <ReturnView
          key={state.blockId ?? 'return'}
          state={state}
          now={now}
          error={error}
          onStartNow={cycle.startNow}
          onFinish={cycle.finish}
          onRate={cycle.rateBlock}
        />
      );
    default:
      return null;
  }
}
