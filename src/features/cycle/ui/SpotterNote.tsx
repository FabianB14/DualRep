import { Notice, type StatusTone } from '@/components';

export type SpotterNoteProps = {
  /** The exercise the advice is about (the card may already show the next one). */
  exerciseName: string;
  /** The spotter's one line ("Drop to 40 lb for the next set."). */
  message: string;
  tone?: StatusTone;
};

/**
 * What the spotter said after the last set: a Notice headed with the exercise it is about. It is a
 * live region, so a screen reader reads each new piece of advice once, right after the set is logged.
 */
export function SpotterNote({ exerciseName, message, tone = 'info' }: SpotterNoteProps) {
  return (
    <Notice
      title={`Spotter · ${exerciseName}`}
      message={message}
      tone={tone}
      accessibilityLabel={`Spotter, ${exerciseName}: ${message}`}
      accessibilityLiveRegion="polite"
    />
  );
}
