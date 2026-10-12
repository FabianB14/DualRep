/**
 * The sign-out confirmation. Signing out deletes this phone's copy of the data, including writes that
 * have not been uploaded yet (disconnectAndClearSync) and spoken or typed notes not added to their
 * plan yet (drafts kept only on the phone, src/features/study/textDrafts.ts), so the dialog says what
 * would be lost and names the destructive button after what it does. A running cycle is finished
 * first (its block and workout are closed), and the dialog says so: its end reaches the server only
 * if the phone is online.
 */
export function signOutWarning(
  pendingUploads: number,
  cycleRunning = false,
  unsentNotes = 0,
): { title: string; message: string; confirmLabel: string } {
  const pending = wholeCount(pendingUploads);
  const plans = wholeCount(unsentNotes);
  const cycle = cycleRunning ? 'Your cycle in progress is finished first. ' : '';
  const notes =
    plans === 0
      ? ''
      : `Notes you haven’t added to ${plans === 1 ? 'their plan' : `${plans} plans`} yet are only on this phone and will be lost. Add them first to keep them.`;
  if (pending === 0 && plans === 0) {
    return {
      title: 'Sign out?',
      message: cycleRunning
        ? `${cycle}Its end is sent to the server if the phone is online. This phone’s copy is then removed.`
        : 'Your data stays safe on the server. This phone’s copy is removed.',
      confirmLabel: 'Sign out',
    };
  }
  if (pending === 0) {
    return {
      title: 'Sign out?',
      message: `${cycle}${cycleRunning ? 'Its end is sent to the server if the phone is online. ' : ''}${notes}`,
      confirmLabel: 'Sign out and lose notes',
    };
  }
  const one = pending === 1;
  return {
    title: 'Sign out?',
    message: `${cycle}${pending} change${one ? ' has' : 's have'} not been uploaded yet and will be lost. Connect to the internet first to keep ${one ? 'it' : 'them'}.${notes ? ` ${notes}` : ''}`,
    confirmLabel: 'Sign out and lose changes',
  };
}

function wholeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
