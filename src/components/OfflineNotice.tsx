import { Notice } from './Notice';

export type OfflineNoticeProps = {
  /** What needs the internet, as the start of a sentence: "Adding material". */
  action: string;
};

/**
 * Says up front that an action needs the internet, before the person spends effort on it. The screen
 * decides when to show it (no sync connection); the action's own error says the same if it is tried
 * anyway, so a wrong guess about the connection never blocks anything.
 */
export function OfflineNotice({ action }: OfflineNoticeProps) {
  return (
    <Notice
      tone="warning"
      title="You seem to be offline"
      message={`${action} needs the internet. Studying and everything else work offline.`}
      accessibilityLiveRegion="polite"
    />
  );
}
