// Writes sample recordings for trying the viewer in Orca into .samples/ (git-ignored): the demo HAR,
// a Playwright-style .har.zip, files near and over Orca's ~50 MiB editor limit, and cut-off,
// damaged, empty and non-HAR files. Everything is synthetic.
//
//   node tools/make-samples.ts

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from '../vendor/fflate/fflate.mjs'
import { demoHar } from '../src/fixtures/demo.ts'
import type { Har, HarEntry } from '../src/har/types.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '.samples')
mkdirSync(root, { recursive: true })
const enc = new TextEncoder()
const MiB = 1024 * 1024

function write(name: string, data: string | Uint8Array): void {
  writeFileSync(join(root, name), data)
  const size = typeof data === 'string' ? enc.encode(data).length : data.length
  console.log(`${name.padEnd(26)} ${(size / MiB).toFixed(2).padStart(7)} MiB`)
}

const text = (har: Har) => JSON.stringify(har, null, 2)

// The demo recording, as browsers save it.
const demo = demoHar()
write('demo.har', text(demo))

// Playwright's "attach" mode: bodies in files next to har.har, named by a hash of the content.
function attached(har: Har): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  const copy = structuredClone(har) as Har
  copy.log.creator = { name: 'Playwright', version: '1.49.0' }
  copy.log.browser = { name: 'chromium', version: '131.0.6778.33' }
  copy.log.entries?.forEach((entry: HarEntry, i) => {
    const content = entry.response?.content
    if (!content || typeof content.text !== 'string') return
    const bytes = content.encoding === 'base64' ? Uint8Array.from(atob(content.text), (c) => c.charCodeAt(0)) : enc.encode(content.text)
    const ext = (content.mimeType ?? '').includes('json') ? 'json' : (content.mimeType ?? '').split('/')[1]?.split(/[;+]/)[0] || 'bin'
    const name = `${(0x9e3779b1 * (i + 1)).toString(16).padStart(8, '0').slice(-8)}${i}.${ext}`
    files[name] = bytes
    delete content.text
    delete content.encoding
    content._file = name
  })
  files['har.har'] = enc.encode(JSON.stringify(copy))
  return zipSync(files)
}
write('demo.har.zip', attached(demo))

// The same recording masked by nothing, with bodies left out (Playwright "omit").
const omitted = structuredClone(demo) as Har
for (const entry of omitted.log.entries ?? []) if (entry.response?.content) delete entry.response.content.text
write('no-bodies.har', text(omitted))

// Near and over the limit: many requests with larger bodies.
function sized(target: number): string {
  let extra = 2000
  for (;;) {
    const out = text(demoHar({ extra }))
    const size = enc.encode(out).length
    if (size >= target * 0.97) return out
    extra = Math.ceil(extra * (target / size) * 1.01)
  }
}
write('large-48mb.har', sized(48 * MiB))
write('over-limit-55mb.har', sized(55 * MiB))

// Damaged files.
const demoText = text(demo)
write('cut-off.har', demoText.slice(0, Math.floor(demoText.length * 0.6)))
const middle = demoText.indexOf('"startedDateTime"', Math.floor(demoText.length / 2))
write('damaged.har', `${demoText.slice(0, middle)}"startedDateTime": 2026-11-15, oops ${demoText.slice(middle + 40)}`)
write('empty.har', '')
write('no-requests.har', text({ log: { version: '1.2', creator: { name: 'Demo', version: '1.0' }, pages: [], entries: [] } }))
write('not-a-har.har', JSON.stringify({ name: 'package', version: '1.0.0' }, null, 2))
write('not-json.har', 'This is a plain text file, not an HTTP Archive.\n')
