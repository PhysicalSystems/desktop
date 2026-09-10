type Installer = {
  on(event: "error", listener: (error: Error) => void): unknown
  removeListener(event: "error", listener: (error: Error) => void): unknown
  quitAndInstall(): void
}

/** electron-updater catches synchronous installer failures and emits error
 * instead of throwing. Do not leave the controller waiting forever for exit.
 * Returning from this handoff does not prove the OS installer completed.
 */
export function launchUpdaterInstaller(installer: Installer, setQuitting: (quitting: boolean) => void) {
  const result: { error?: Error } = {}
  const failed = (error: Error) => {
    result.error = error
  }
  installer.on("error", failed)
  setQuitting(true)
  try {
    installer.quitAndInstall()
    if (result.error) throw result.error
  } catch (error) {
    setQuitting(false)
    throw error
  } finally {
    installer.removeListener("error", failed)
  }
}
