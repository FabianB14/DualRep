/**
 * The sign-out confirmation. Signing out deletes this phone's copy of the data, including writes that
 * have not been uploaded yet (disconnectAndClearSync), so the dialog says how many would be lost and
 * names the destructive button after what it does.
 */
export function signOutWarning(pendingUploads: number): { title: string; message: string; confirmLabel: string } {
  const pending = Number.isFinite(pendingUploads) && pendingUploads > 0 ? Math.floor(pendingUploads) : 0;
  if (pending === 0) {
    return {
      title: 'Sign out?',
      message: 'Your data stays safe on the server. This phone’s copy is removed.',
      confirmLabel: 'Sign out',
    };
  }
  const one = pending === 1;
  return {
    title: 'Sign out?',
    message: `${pending} change${one ? ' has' : 's have'} not been uploaded yet and will be lost. Connect to the internet first to keep ${one ? 'it' : 'them'}.`,
    confirmLabel: 'Sign out and lose changes',
  };
}
