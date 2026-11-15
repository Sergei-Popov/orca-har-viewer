// Waiting for Orca's hello. Orca sends it to the frame after the frame has loaded, with its UI
// language and theme. Until it arrives, orca.locale falls back to the system language
// (navigator.language), which may not be Orca's: picking the strings at load time showed a
// Russian viewer in an English Orca on a Russian Mac. So the editor picks its strings only once
// hello is in. Hello puts the light or dark class on <html> and fires `theme`; either signal will do.

export type HelloSignals = {
  /** True once Orca's light or dark class is on <html>. */
  themed: () => boolean
  /** Subscribes to Orca's `theme` event; undefined outside Orca. */
  onTheme?: (handler: () => void) => { dispose(): void }
  /** Stops waiting after this long, in case a hello brings no theme. */
  timeoutMs?: number
}

export function helloArrived({ themed, onTheme, timeoutMs = 2000 }: HelloSignals): Promise<void> {
  if (!onTheme || themed()) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    let listener: { dispose(): void } | undefined
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      listener?.dispose()
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    listener = onTheme(finish)
    if (done) listener.dispose()
  })
}
