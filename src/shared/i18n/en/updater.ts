/** Auto-update status messages (main process). */
export const updater = {
  unpackaged: 'Updates are checked in installed builds.',
  portable: "Portable builds don't auto-update; download the latest release.",
  offline: 'Could not reach GitHub to check for updates. Check your internet connection.',
  noRelease: 'No update information was found on GitHub.',
  rateLimited: 'GitHub is limiting update checks right now. Try again later.',
  integrity: 'The downloaded update failed its integrity check and was discarded. Try again.',
  failed: 'Update failed: {reason}',
  noUpdate: 'No update is available to download. Check for updates first.',
  notDownloaded: 'The update has not been downloaded yet.',
} as const
