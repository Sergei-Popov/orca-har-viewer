// Writes the demo recording the listing images are built from, into .orca/listing/samples/
// (git-ignored): a patched copy of demoHar(), which stays as it is because tests pin it. Every
// host is example.com, every address TEST-NET, every name and token made up.
//
//   node tools/make-listing-samples.ts      -> .orca/listing/samples/dashboard.har
//
// Then, from the hub: scripts/listing-image.sh har-viewer --dry-run --check --sheet

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { demoHar } from '../src/fixtures/demo.ts'
import type { HarEntry, HarWebSocketMessage } from '../src/har/types.ts'

const har = structuredClone(demoHar())

// The digest and the overview print these: a neutral recorder, no browser or vendor names.
har.log.creator = { name: 'demo-recorder', version: '1.0' }
har.log.browser = { name: 'Demo Browser', version: '1.0' }

const entries: HarEntry[] = har.log.entries ?? []
const exportEntry = entries.find((e) => e.request?.method === 'POST' && e.request.url?.endsWith('/v1/reports/export'))
if (!exportEntry?.timings) throw new Error('no POST /v1/reports/export in demoHar()')

// Every phase on the slow request: DNS 18, connect 42, TLS 31, wait 1,198, receive 9 ms.
const t = exportEntry.timings
t.dns = 18
t.ssl = 31
t.connect = 42 + 31 // HAR's connect includes the TLS time
t.wait = 1198
t.receive = 9
exportEntry.time = Math.round([t.blocked, t.dns, t.connect, t.send, t.wait, t.receive].reduce((sum: number, v) => sum + Math.max(0, v ?? 0), 0) * 1000) / 1000

for (const e of entries) {
  for (const header of [...(e.request?.headers ?? []), ...(e.response?.headers ?? [])]) {
    const name = header.name.toLowerCase()
    // Server-Timing: no database brand.
    if (name === 'server-timing') header.value = header.value.replace('desc="Postgres"', e === exportEntry ? 'desc="report query"' : 'desc="query"')
    // The analytics cookie gets a neutral name.
    if (name === 'cookie') header.value = header.value.replace('_ga=GA1.1.demo.', 'visit=demo.')
    // Browser hints without browser or OS names.
    if (name === 'user-agent') header.value = 'DemoBrowser/1.0 (demo)'
    if (name === 'sec-ch-ua') header.value = '"Demo Browser";v="1"'
    if (name === 'sec-ch-ua-platform') header.value = '"Demo OS"'
  }
}

// /socket?v=3: JSON frames in both directions. Order 48207 runs through them (a presence frame
// each way and two updates), so filtering the messages by "48207" leaves four in both directions.
const socket = entries.find((e) => e.request?.url === 'wss://realtime.example.com/socket?v=3')
const old = socket?._webSocketMessages
if (!socket || !old || old.length < 2) throw new Error('no /socket?v=3 in demoHar()')
const base = old[0].time ?? 0
const order = (id: number, status: string, total: number, items: number) => ({ type: 'order.updated', order: { id, status, total, items } })
const presence = (user: string, state: string, page: string) => ({ type: 'presence', user, state, page })
const script: ['send' | 'receive', object][] = [
  ['send', { type: 'subscribe', channels: ['orders', 'presence'] }],
  ['receive', order(48210, 'paid', 114.68, 3)],
  ['receive', presence('ops-team-3', 'viewing', '/orders/48207')],
  ['send', presence('demo-user', 'viewing', '/orders/48207')],
  ['receive', order(48209, 'packed', 313.1, 2)],
  ['receive', order(48207, 'packed', 35.14, 1)],
  ['send', presence('demo-user', 'idle', '/dashboard')],
  ['receive', order(48208, 'shipped', 421.92, 4)],
  ['receive', order(48210, 'shipped', 114.68, 3)],
  ['receive', presence('ops-team-3', 'idle', '/dashboard')],
  ['send', presence('demo-user', 'viewing', '/orders/48209')],
  ['receive', order(48207, 'shipped', 35.14, 1)],
  ['receive', order(48209, 'out_for_delivery', 313.1, 2)],
  ['send', presence('demo-user', 'idle', '/dashboard')],
  ['receive', order(48208, 'delivered', 421.92, 4)]
]
// The first two frames stay: auth (its token is masked by Mask secrets) and ready.
const frames: HarWebSocketMessage[] = [old[0], old[1]]
let time = base + 0.05
script.forEach(([type, body], i) => {
  frames.push({ type, time, opcode: 1, data: JSON.stringify({ ...body, at: new Date(time * 1000).toISOString() }) })
  time += 0.35 + ((i * 37) % 11) / 10
})
frames.push({ type: 'send', time, opcode: 9, data: '' }, { type: 'receive', time: time + 0.04, opcode: 10, data: '' })
socket._webSocketMessages = frames

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.orca', 'listing', 'samples')
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'dashboard.har')
writeFileSync(out, JSON.stringify(har, null, 2))
console.log(`${out}: ${entries.length} requests, ${frames.length} WebSocket frames`)
