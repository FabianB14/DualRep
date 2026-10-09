/**
 * The sign-out confirmation. Signing out deletes this phone's copy of the data, including writes that
 * have not been uploaded yet (disconnectAndClearSync), so the dialog says how many would be lost and
 * names the destructive button after what it does. A running cycle is finished first (its block and
 * workout are closed), and the dialog says so: its end reaches the server only if the phone is online.
 */
export function signOutWarning(
  pendingUploads: number,
  cycleRunning = false,
): { title: string; message: string; confirmLabel: string } {
  const pending = Number.isFinite(pendingUploads) && pendingUploads > 0 ? Math.floor(pendingUploads) : 0;
  const cycle = cycleRunning ? 'Your cycle in progress is finished first. ' : '';
  if (pending === 0) {
    return {
      title: 'Sign out?',
      message: cycleRunning
        ? `${cycle}Its end is sent to the server if the phone is online. This phone’s copy is then removed.`
        : 'Your data stays safe on the server. This phone’s copy is removed.',
      confirmLabel: 'Sign out',
    };
  }
  const one = pending === 1;
  return {
    title: 'Sign out?',
    message: `${cycle}${pending} change${one ? ' has' : 's have'} not been uploaded yet and will be lost. Connect to the internet first to keep ${one ? 'it' : 'them'}.`,
    confirmLabel: 'Sign out and lose changes',
  };
}
