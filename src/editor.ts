// The custom editor. Orca opens a .har (as text) or a Playwright .har.zip (as bytes) in a tab here,
// from the file tree, a file link in a chat or `orca file open`. Orca keeps files over ~50 MiB
// out of custom editors and shows its own notice. The viewer never edits, so Orca never saves the
// tab; when the file changes on disk it is read again, keeping the filters and the selection.

import { decodeText, type SideFiles } from './har/body'
import { readHar, type ReadResult } from './har/read'
import { isZip, openHarZip, ZipError } from './har/zip'
import { fill, stringsFor, type Strings } from './i18n'
import { installStyles } from './styles'
import { HarApp, type Recording } from './ui/app'

const locale = globalThis.orca?.locale || navigator.language || 'en'
const strings = stringsFor(locale)
document.documentElement.lang = locale
installStyles()
const app = new HarApp({ strings, locale, saveAs: globalThis.orca?.files?.saveAs })
document.body.append(app.root)
app.showLoading()

type Opened = { result: ReadResult; files?: SideFiles; zip: boolean }

function openBytes(bytes: Uint8Array): Opened {
  if (isZip(bytes)) {
    const zip = openHarZip(bytes)
    return { result: readHar(zip.text), files: zip.files, zip: true }
  }
  // Not a ZIP after all: a plain HAR saved under .har.zip still opens.
  return { result: readHar(decodeText(bytes)), zip: false }
}

function readError(result: Extract<ReadResult, { ok: false }>, s: Strings): [string, string | undefined] {
  const at = result.line !== undefined ? fill(s.errorAt, { line: result.line, column: result.column ?? 1, message: result.message }) : undefined
  if (result.reason === 'empty') return [s.errorEmpty, undefined]
  return [result.reason === 'not-har' ? s.errorNotHar : s.errorNotJson, at]
}

function zipError(error: ZipError, s: Strings): string {
  switch (error.code) {
    case 'not-zip':
      return s.errorNotZip
    case 'no-har':
      return s.errorNoHar
    case 'too-large':
      return s.errorZipLarge
    case 'method':
      return s.errorZipMethod
    default:
      return s.errorZipDamaged
  }
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
    // Let the spinner paint before a large file is parsed on this thread.
    await new Promise((resolve) => setTimeout(resolve, 16))
    if (current !== generation) return
    let opened: Opened
    try {
      opened = doc.content.kind === 'text' ? { result: readHar(doc.content.text), zip: false } : openBytes(new Uint8Array(doc.content.bytes))
    } catch (error) {
      if (current !== generation) return
      shown = false
      if (error instanceof ZipError) app.showError(strings.errorTitle, zipError(error, strings), error.message)
      else {
        console.warn('[har-viewer] cannot open the file', error)
        app.showError(strings.errorTitle, strings.errorZipDamaged, error instanceof Error ? error.message : String(error))
      }
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
    const recording: Recording = { har: result.har, issue: result.issue, files: opened.files, zip: opened.zip }
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
