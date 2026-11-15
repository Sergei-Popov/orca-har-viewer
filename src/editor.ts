// The custom editor. Orca opens a .har (as text) or a Playwright .har.zip (as bytes) in a tab here,
// from the file tree, a file link in a chat or `orca file open`. Orca keeps files over ~50 MiB
// out of custom editors and shows its own notice. The viewer never edits, so Orca never saves the
// tab; when the file changes on disk it is read again, keeping the filters and the selection.

import { decodeText, type SideFiles } from './har/body'
import { readHar, type ReadResult } from './har/read'
import { isZip, openHarZip } from './har/zip'
import { helloArrived } from './hello'
import { stringsFor, type Strings } from './i18n'
import { openError, readError } from './open-errors'
import { installStyles } from './styles'
import { HarApp, type Recording } from './ui/app'

installStyles()
let locale = ''
let strings!: Strings
let app!: HarApp
localize()
app.showLoading()

/** Builds the view for Orca's language; again when the language turns out different. */
function localize(): void {
  const next = globalThis.orca?.locale || navigator.language || 'en'
  if (app && next === locale) return
  locale = next
  strings = stringsFor(locale)
  document.documentElement.lang = locale
  const previous = app
  app = new HarApp({ strings, locale, saveAs: globalThis.orca?.files?.saveAs })
  if (previous) previous.root.replaceWith(app.root)
  else document.body.append(app.root)
}

// Orca's language is known only once its hello is in (see hello.ts); the view built before that
// only shows the spinner and is rebuilt if the language differs.
const orca = globalThis.orca
const hello = helloArrived({
  themed: () => document.documentElement.classList.contains('light') || document.documentElement.classList.contains('dark'),
  onTheme: orca?.on ? (handler) => orca.on('theme', handler) : undefined,
}).then(() => {
  localize()
  app.showLoading()
})

type Opened = { result: ReadResult; files?: SideFiles; zip: boolean }

function openBytes(bytes: Uint8Array): Opened {
  if (isZip(bytes)) {
    const zip = openHarZip(bytes)
    return { result: readHar(zip.text), files: zip.files, zip: true }
  }
  // Not a ZIP after all: a plain HAR saved under .har.zip still opens.
  return { result: readHar(decodeText(bytes)), zip: false }
}

const api = globalThis.orca?.document
if (!api) {
  app.showError(strings.errorTitle, strings.noHost)
} else {
  let generation = 0
  let shown = false
  api.onDidChange(async (doc) => {
    const current = ++generation
    if (!shown) app.showLoading()
    await hello
    // Let the spinner paint before a large file is parsed on this thread.
    await new Promise((resolve) => setTimeout(resolve, 16))
    if (current !== generation) return
    let opened: Opened
    try {
      opened = doc.content.kind === 'text' ? { result: readHar(doc.content.text), zip: false } : openBytes(new Uint8Array(doc.content.bytes))
    } catch (error) {
      if (current !== generation) return
      shown = false
      console.warn('[har-viewer] cannot open the file', error)
      app.showError(strings.errorTitle, ...openError(error, strings))
      return
    }
    if (current !== generation) return
    const { result } = opened
    if (!result.ok) {
      shown = false
      const [message, detail] = readError(result, strings)
      app.showError(strings.errorTitle, message, detail)
      return
    }
    const recording: Recording = { har: result.har, issue: result.issue, files: opened.files, zip: opened.zip, compact: result.compact }
    try {
      app.open(recording)
      shown = true
    } catch (error) {
      console.error('[har-viewer] cannot show the file', error)
      shown = false
      app.showError(strings.errorTitle, strings.errorNotHar, error instanceof Error ? error.message : String(error))
    }
  })
}
