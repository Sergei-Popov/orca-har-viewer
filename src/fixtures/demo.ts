// A realistic HAR built from synthetic data, for tests, the README's screenshots and manual
// testing: a dashboard on example.com domains with a document, styles, scripts, fonts, images,
// API calls (one failing, one missing, one refused), GraphQL, a WebSocket, WebAssembly, media,
// cached requests and a second page. Same seed, same file. All secrets in it are fake.
//
// Imports carry their `.ts` extension so `node tools/make-samples.ts` can run it directly.

import type { Har, HarEntry, HarInitiator, HarNameValue, HarPage, HarWebSocketMessage } from '../har/types.ts'

export type DemoOptions = {
  /** Extra API calls on the first page, for big files. */
  extra?: number
  seed?: number
}

const T0 = Date.UTC(2026, 10, 15, 9, 41, 12, 0)
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Fake credentials, in the shapes real ones have, for the sanitizer to find. */
export const DEMO_SECRETS = {
  jwt: `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url('{"sub":"user_demo_42","name":"Demo User","role":"admin","exp":1795000000}')}.ZGVtby1zaWduYXR1cmUtbm90LXJlYWwtMTIzNA`,
  session: 's%3Ademo-session-7f3a9c2e1b.Xq2dEMOsig',
  providerKey: 'sk-demo-DEMOdemoDEMOdemoDEMOdemo0000',
  analyticsKey: 'ak_demo_51c9e0d2f4',
  csrf: 'demo-csrf-4b1f8e2a9c'
}

function b64(text: string): string {
  return bytesToB64(new TextEncoder().encode(text))
}
function b64url(text: string): string {
  return b64(text).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}
function bytesToB64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const iso = (ms: number) => new Date(Math.floor(ms)).toISOString()

function queryOf(url: URL): HarNameValue[] {
  const list: HarNameValue[] = []
  url.searchParams.forEach((value, name) => list.push({ name, value }))
  return list
}

type Spec = {
  url: string
  method?: string
  status?: number
  statusText?: string
  type: string
  mime?: string
  /** Start, ms after T0. */
  at: number
  /** Server wait and download, ms. */
  wait: number
  receive?: number
  /** New connection: dns, connect, ssl ms. */
  connect?: [number, number, number]
  blocked?: number
  body?: string
  bodyBase64?: string
  /** Size of a body not recorded. */
  size?: number
  transfer?: number
  requestHeaders?: HarNameValue[]
  responseHeaders?: HarNameValue[]
  postData?: { mimeType: string; text: string }
  initiator?: HarInitiator
  priority?: string
  cache?: 'memory' | 'disk'
  page?: string
  error?: string
  messages?: HarWebSocketMessage[]
  ip?: string
}

const DOC = 'https://app.example.com/dashboard'
const APP_JS = 'https://app.example.com/assets/app.3f9a2c.js'
const VENDOR_JS = 'https://app.example.com/assets/vendor.81b2d0.js'
const APP_CSS = 'https://app.example.com/assets/app.5e1d77.css'

function stack(fn: string, line: number, parentFn = 'loadDashboard', description = 'await'): HarInitiator {
  return {
    type: 'script',
    stack: {
      callFrames: [
        { functionName: 'request', scriptId: '41', url: APP_JS, lineNumber: 211, columnNumber: 18 },
        { functionName: fn, scriptId: '41', url: APP_JS, lineNumber: line, columnNumber: 9 }
      ],
      parent: {
        description,
        callFrames: [
          { functionName: parentFn, scriptId: '41', url: APP_JS, lineNumber: 48, columnNumber: 4 },
          { functionName: '', scriptId: '41', url: APP_JS, lineNumber: 12, columnNumber: 1 }
        ]
      }
    }
  }
}

const parser = (url: string, line: number): HarInitiator => ({ type: 'parser', url, lineNumber: line })

function chromeRequestHeaders(spec: Spec, origin: boolean): HarNameValue[] {
  const u = new URL(spec.url)
  const dest: Record<string, string> = { doc: 'document', js: 'script', css: 'style', img: 'image', font: 'font', media: 'video' }
  const list: HarNameValue[] = [
    { name: ':authority', value: u.host },
    { name: ':method', value: spec.method ?? 'GET' },
    { name: ':path', value: `${u.pathname}${u.search}` },
    { name: ':scheme', value: 'https' },
    {
      name: 'accept',
      value:
        spec.type === 'doc'
          ? 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
          : spec.type === 'img'
            ? 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
            : spec.type === 'css'
              ? 'text/css,*/*;q=0.1'
              : spec.type === 'fetch'
                ? 'application/json'
                : '*/*'
    },
    { name: 'accept-encoding', value: 'gzip, deflate, br, zstd' },
    { name: 'accept-language', value: 'en-US,en;q=0.9' },
    ...(spec.requestHeaders ?? []),
    ...(origin ? [{ name: 'origin', value: 'https://app.example.com' }] : []),
    ...(spec.type !== 'doc' ? [{ name: 'referer', value: 'https://app.example.com/' }] : []),
    { name: 'sec-ch-ua', value: '"Chromium";v="131", "Not_A Brand";v="24"' },
    { name: 'sec-ch-ua-mobile', value: '?0' },
    { name: 'sec-ch-ua-platform', value: '"macOS"' },
    { name: 'sec-fetch-dest', value: dest[spec.type] ?? 'empty' },
    { name: 'sec-fetch-mode', value: spec.type === 'doc' ? 'navigate' : spec.type === 'fetch' ? 'cors' : 'no-cors' },
    { name: 'sec-fetch-site', value: u.host === 'app.example.com' ? 'same-origin' : 'same-site' },
    { name: 'user-agent', value: UA }
  ]
  return list
}

function toEntry(spec: Spec, rand: () => number): HarEntry {
  const u = new URL(spec.url)
  const blocked = spec.blocked ?? Math.round(rand() * 30) / 10 + 0.4
  const [dns, connect, ssl] = spec.connect ?? [-1, -1, -1]
  const send = Math.round(rand() * 6) / 10 + 0.1
  const receive = spec.receive ?? Math.round(rand() * 40) / 10 + 0.3
  const failed = spec.status === 0
  const timings = failed
    ? { blocked, dns: -1, connect: -1, ssl: -1, send: 0, wait: 0, receive: 0, _blocked_queueing: Math.min(blocked, 0.6) }
    : {
        blocked,
        dns,
        connect: connect >= 0 ? connect + Math.max(0, ssl) : -1,
        ssl,
        send,
        wait: spec.wait,
        receive,
        _blocked_queueing: Math.round(Math.min(blocked, 0.3 + rand()) * 100) / 100
      }
  const time = failed ? blocked + spec.wait : [blocked, dns, timings.connect, send, spec.wait, receive].reduce((sum, v) => sum + Math.max(0, v), 0)
  const mime = spec.mime ?? 'application/json'
  const text = spec.body
  const bodyLength = spec.bodyBase64 ? Math.floor((spec.bodyBase64.length * 3) / 4) : text !== undefined ? new TextEncoder().encode(text).length : (spec.size ?? 0)
  const compressed = /json|javascript|css|html|svg/.test(mime) ? Math.round(bodyLength * 0.32) : bodyLength
  const headersSize = 180 + Math.round(rand() * 220)
  const transfer = spec.cache ? 0 : (spec.transfer ?? (failed ? 0 : compressed + headersSize))
  const status = spec.status ?? 200
  const responseHeaders: HarNameValue[] = failed
    ? []
    : [
        { name: 'content-type', value: mime },
        ...(bodyLength ? [{ name: 'content-length', value: String(compressed) }] : []),
        ...(/json|javascript|css|html|svg/.test(mime) ? [{ name: 'content-encoding', value: 'br' }] : []),
        { name: 'date', value: 'Sun, 15 Nov 2026 09:41:12 GMT' },
        {
          name: 'cache-control',
          value: spec.type === 'fetch' || spec.type === 'doc' ? 'no-store' : 'public, max-age=31536000, immutable'
        },
        ...(spec.responseHeaders ?? []),
        { name: 'server', value: 'demo-edge' }
      ]
  const entry: HarEntry = {
    _initiator: spec.initiator ?? { type: 'other' },
    _priority: spec.priority ?? (spec.type === 'doc' || spec.type === 'css' ? 'VeryHigh' : spec.type === 'js' || spec.type === 'font' ? 'High' : spec.type === 'img' ? 'Low' : 'High'),
    _resourceType:
      { doc: 'document', js: 'script', css: 'stylesheet', img: 'image', font: 'font', fetch: 'fetch', xhr: 'xhr', ws: 'websocket', media: 'media', wasm: 'fetch', other: 'other', manifest: 'manifest', ping: 'ping', preflight: 'preflight' }[spec.type] ?? 'other',
    cache: {},
    connection: failed ? undefined : String(400000 + Math.floor(rand() * 9000)),
    pageref: spec.page ?? 'page_1',
    request: {
      method: spec.method ?? 'GET',
      url: spec.url,
      httpVersion: spec.type === 'ws' ? 'HTTP/1.1' : 'http/2.0',
      headers: chromeRequestHeaders(spec, spec.type === 'fetch' || spec.type === 'xhr' || spec.method === 'POST'),
      queryString: queryOf(u),
      cookies: [],
      headersSize: -1,
      bodySize: spec.postData ? new TextEncoder().encode(spec.postData.text).length : 0,
      ...(spec.postData ? { postData: spec.postData } : {})
    },
    response: {
      status,
      statusText: failed ? '' : (spec.statusText ?? ''),
      httpVersion: failed ? '' : spec.type === 'ws' ? 'HTTP/1.1' : 'http/2.0',
      headers: responseHeaders,
      cookies: [],
      content: {
        size: failed ? 0 : bodyLength,
        mimeType: failed ? 'x-unknown' : mime,
        ...(spec.bodyBase64 ? { text: spec.bodyBase64, encoding: 'base64' } : text !== undefined ? { text } : {}),
        ...(compressed !== bodyLength && bodyLength ? { compression: bodyLength - compressed } : {})
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: -1,
      _transferSize: transfer,
      _error: spec.error ?? null
    },
    serverIPAddress: failed ? '' : (spec.ip ?? (u.host.startsWith('api') ? '203.0.113.20' : u.host.startsWith('cdn') ? '198.51.100.7' : '203.0.113.10')),
    startedDateTime: iso(T0 + spec.at),
    time: Math.round(time * 1000) / 1000,
    timings
  }
  if (spec.cache) {
    entry._fromCache = spec.cache
    entry.timings = { blocked: 0.2, dns: -1, connect: -1, ssl: -1, send: 0, wait: 0.4, receive: 0.3, _blocked_queueing: 0.1 }
    entry.time = 0.9
    entry.serverIPAddress = ''
  }
  if (spec.messages) entry._webSocketMessages = spec.messages
  if (spec.error) entry._error = spec.error
  return entry
}

// ── Bodies ───────────────────────────────────────────────────────────────────────────────────

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf-token" content="${DEMO_SECRETS.csrf}">
  <title>Dashboard · example.com</title>
  <link rel="stylesheet" href="/assets/app.5e1d77.css">
  <link rel="preload" href="https://fonts.example.net/inter-var.woff2" as="font" crossorigin>
  <link rel="manifest" href="/manifest.webmanifest">
</head>
<body>
  <!-- Rendered on the server, hydrated by app.js -->
  <div id="root" data-user="user_demo_42">
    <header class="top-bar"><img src="https://cdn.example.net/img/logo.svg" alt="Demo" width="96"></header>
    <main class="grid">
      <section class="card" id="revenue"><h2>Revenue</h2><canvas width="640" height="240"></canvas></section>
      <section class="card" id="orders"><h2>Recent orders</h2><ul></ul></section>
    </main>
  </div>
  <script src="/assets/vendor.81b2d0.js" defer></script>
  <script src="/assets/app.3f9a2c.js" defer></script>
</body>
</html>
`

const CSS = `:root {
  --bg: #0f1115;
  --fg: #e6e8ee;
  --accent: #4f8cff;
  --radius: 10px;
}
@font-face {
  font-family: "Inter";
  src: url("https://fonts.example.net/inter-var.woff2") format("woff2");
  font-display: swap;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 14px/1.5 Inter, system-ui, sans-serif;
  color: var(--fg);
  background: var(--bg);
}
.top-bar { display: flex; align-items: center; height: 56px; padding: 0 24px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; padding: 24px; }
.card { background: #171a21; border-radius: var(--radius); padding: 16px 20px; }
.card h2 { margin: 0 0 12px; font-size: 13px; letter-spacing: .04em; text-transform: uppercase; color: #9aa3b5; }
@media (max-width: 720px) {
  .grid { padding: 12px; gap: 12px; }
}
`

const APP = `// app.js — dashboard client (demo)
import { createChart } from './charts.js'
import { http } from './http.js'

const API = 'https://api.example.com/v1'
let token = sessionStorage.getItem('access')

async function main() {
  const me = await loadMe()
  await loadDashboard(me)
  connectRealtime()
}

export async function loadDashboard(me) {
  const [metrics, orders] = await Promise.all([loadMetrics('7d'), loadOrders(20)])
  createChart(document.querySelector('#revenue canvas'), metrics.series)
  renderOrders(orders.items)
  if (me.role === 'admin') prefetchReports()
}

async function request(path, init = {}) {
  const response = await http.send(\`\${API}\${path}\`, {
    ...init,
    headers: { authorization: \`Bearer \${token}\`, ...init.headers }
  })
  if (!response.ok) throw new Error(\`\${response.status} \${path}\`)
  return response.status === 204 ? null : response.json()
}

const loadMe = () => request('/me')
const loadMetrics = (range) => request(\`/metrics?range=\${range}&tz=UTC\`)
const loadOrders = (limit) => request(\`/orders?limit=\${limit}&status=open\`)

function renderOrders(items) {
  const list = document.querySelector('#orders ul')
  for (const order of items) {
    const li = document.createElement('li')
    li.textContent = \`#\${order.id} · \${order.customer} · $\${order.total.toFixed(2)}\`
    list.append(li)
  }
}

main().catch((error) => console.error('dashboard failed', error))
`

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="48" viewBox="0 0 192 48">
  <rect width="48" height="48" rx="12" fill="#4f8cff"/>
  <path d="M14 30 L22 18 L28 26 L34 16" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="60" y="32" font-family="sans-serif" font-size="22" font-weight="700" fill="#4f8cff">demo</text>
</svg>
`

function metricsBody(rand: () => number): string {
  const series = []
  let revenue = 18400
  for (let day = 0; day < 7; day++) {
    revenue += Math.round((rand() - 0.35) * 2600)
    series.push({
      date: new Date(Date.UTC(2026, 10, 8 + day)).toISOString().slice(0, 10),
      revenue,
      orders: Math.round(revenue / 74),
      refunds: Math.round(rand() * 9)
    })
  }
  return JSON.stringify(
    {
      range: '7d',
      currency: 'USD',
      totals: { revenue: series.reduce((s, d) => s + d.revenue, 0), orders: series.reduce((s, d) => s + d.orders, 0), conversion: 0.0342 },
      series,
      generatedAt: '2026-11-15T09:41:12.512Z'
    },
    null,
    2
  )
}

function ordersBody(rand: () => number, count: number): string {
  const customers = ['Ada Park', 'Leon Ito', 'Mira Costa', 'Tomás Reyes', 'Ines Varga', 'Kai Novak', 'Ruth Adeyemi', 'Omar Haddad']
  const items = []
  for (let i = 0; i < count; i++) {
    items.push({
      id: 48210 - i,
      customer: customers[i % customers.length],
      total: Math.round((20 + rand() * 480) * 100) / 100,
      status: i % 7 === 3 ? 'pending' : 'paid',
      items: 1 + Math.floor(rand() * 4),
      createdAt: new Date(T0 - i * 3_600_000 * (1 + rand())).toISOString()
    })
  }
  return JSON.stringify({ items, next: '/v1/orders?limit=20&status=open&cursor=b3JkZXJfNDgxOTA' })
}

/** A small PNG (a bar chart on a gradient), built with stored DEFLATE blocks. */
export function demoPng(width = 160, height = 100): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height)
  const bars = [0.35, 0.52, 0.44, 0.7, 0.62, 0.86, 0.78]
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const bar = Math.floor((x / width) * bars.length)
      const inBar = x % Math.ceil(width / bars.length) > 3 && y > height * (1 - bars[bar])
      const p = row + 1 + x * 3
      raw[p] = inBar ? 79 : 24 + Math.round((y / height) * 18)
      raw[p + 1] = inBar ? 140 : 28 + Math.round((y / height) * 20)
      raw[p + 2] = inBar ? 255 : 38 + Math.round((x / width) * 30)
    }
  }
  return png(width, height, raw)
}

function png(width: number, height: number, raw: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr.set([8, 2, 0, 0, 0], 8)
  chunks.push(chunk('IHDR', ihdr), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array()))
  return concat(chunks)
}

function zlibStored(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])]
  for (let at = 0; at < data.length || at === 0; at += 65535) {
    const block = data.subarray(at, Math.min(data.length, at + 65535))
    const last = at + 65535 >= data.length ? 1 : 0
    parts.push(new Uint8Array([last, block.length & 0xff, block.length >> 8, ~block.length & 0xff, (~block.length >> 8) & 0xff]), block)
    if (last) break
  }
  let a = 1
  let b = 0
  for (const byte of data) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  parts.push(new Uint8Array([b >> 8, b & 0xff, a >> 8, a & 0xff]))
  return concat(parts)
}

const CRC = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  let crc = 0xffffffff
  for (let i = 4; i < 8 + data.length; i++) crc = CRC[(crc ^ out[i]) & 0xff] ^ (crc >>> 8)
  view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0)
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

// ── The archive ──────────────────────────────────────────────────────────────────────────────

export function demoHar(options: DemoOptions = {}): Har {
  const rand = rng(options.seed ?? 42)
  const auth = { name: 'authorization', value: `Bearer ${DEMO_SECRETS.jwt}` }
  const cookie = { name: 'cookie', value: `sid=${DEMO_SECRETS.session}; theme=dark; _ga=GA1.1.demo.1731663672` }
  const json = 'application/json; charset=utf-8'
  const serverTiming = (db: number, app: number) => ({ name: 'server-timing', value: `db;dur=${db};desc="Postgres", app;dur=${app}, cache;desc="miss"` })
  const specs: Spec[] = [
    {
      url: 'http://app.example.com/dashboard',
      type: 'doc',
      status: 301,
      statusText: 'Moved Permanently',
      mime: 'text/html',
      at: 0,
      wait: 18.2,
      connect: [12.4, 9.8, -1],
      responseHeaders: [{ name: 'location', value: DOC }],
      size: 0,
      transfer: 212
    },
    {
      url: DOC,
      type: 'doc',
      mime: 'text/html; charset=utf-8',
      at: 42,
      wait: 96.4,
      receive: 6.1,
      connect: [0.4, 14.2, 21.7],
      body: HTML,
      requestHeaders: [cookie],
      responseHeaders: [
        { name: 'set-cookie', value: `sid=${DEMO_SECRETS.session}; Path=/; HttpOnly; Secure; SameSite=Lax` },
        { name: 'x-request-id', value: 'req_7d1c40e2' },
        serverTiming(21.4, 58.9)
      ]
    },
    { url: APP_CSS, type: 'css', mime: 'text/css', at: 188, wait: 22.1, receive: 3.4, body: CSS, initiator: parser(DOC, 7) },
    {
      url: 'https://fonts.example.net/inter-var.woff2',
      type: 'font',
      mime: 'font/woff2',
      at: 190,
      wait: 31.5,
      receive: 28.2,
      connect: [8.1, 11.6, 18.9],
      size: 318_420,
      transfer: 318_770,
      initiator: parser(DOC, 8)
    },
    { url: VENDOR_JS, type: 'js', mime: 'application/javascript', at: 192, wait: 24.8, receive: 61.3, size: 412_311, initiator: parser(DOC, 22) },
    { url: APP_JS, type: 'js', mime: 'application/javascript', at: 193, wait: 26.0, receive: 9.4, body: APP, initiator: parser(DOC, 23) },
    { url: 'https://cdn.example.net/img/logo.svg', type: 'img', mime: 'image/svg+xml', at: 196, wait: 19.6, connect: [9.2, 10.4, 17.3], body: SVG, initiator: parser(DOC, 16) },
    { url: 'https://app.example.com/manifest.webmanifest', type: 'manifest', mime: 'application/manifest+json', at: 205, wait: 15.2, body: '{"name":"Demo dashboard","start_url":"/dashboard","display":"standalone","icons":[{"src":"/icon-192.png","sizes":"192x192"}]}', initiator: { type: 'other' } },
    {
      url: 'https://api.example.com/v1/me',
      type: 'fetch',
      mime: json,
      at: 512,
      wait: 64.2,
      connect: [10.2, 12.9, 19.4],
      requestHeaders: [auth],
      responseHeaders: [serverTiming(8.1, 31.6), { name: 'x-request-id', value: 'req_7d1c4127' }],
      body: JSON.stringify({ id: 'user_demo_42', name: 'Demo User', email: 'demo@example.com', role: 'admin', plan: 'team', features: ['reports', 'exports', 'realtime'] }, null, 2),
      initiator: stack('loadMe', 34, 'main', 'await')
    },
    {
      url: 'https://api.example.com/v1/me',
      method: 'OPTIONS',
      type: 'preflight',
      status: 204,
      statusText: 'No Content',
      mime: 'text/plain',
      at: 505,
      wait: 21.3,
      size: 0,
      requestHeaders: [
        { name: 'access-control-request-method', value: 'GET' },
        { name: 'access-control-request-headers', value: 'authorization' }
      ],
      responseHeaders: [
        { name: 'access-control-allow-origin', value: 'https://app.example.com' },
        { name: 'access-control-allow-headers', value: 'authorization, content-type' },
        { name: 'access-control-max-age', value: '600' }
      ],
      initiator: stack('loadMe', 34, 'main', 'await')
    },
    {
      url: 'https://api.example.com/v1/metrics?range=7d&tz=UTC',
      type: 'fetch',
      mime: json,
      at: 604,
      wait: 238.6,
      receive: 4.2,
      requestHeaders: [auth],
      responseHeaders: [serverTiming(181.2, 44.0)],
      body: metricsBody(rand),
      initiator: stack('loadMetrics', 36, 'loadDashboard', 'Promise.all')
    },
    {
      url: 'https://api.example.com/v1/orders?limit=20&status=open',
      type: 'fetch',
      mime: json,
      at: 605,
      wait: 141.9,
      receive: 5.5,
      requestHeaders: [auth],
      responseHeaders: [serverTiming(96.5, 33.1)],
      body: ordersBody(rand, 20),
      initiator: stack('loadOrders', 37, 'loadDashboard', 'Promise.all')
    },
    {
      url: 'https://api.example.com/graphql',
      method: 'POST',
      type: 'fetch',
      mime: json,
      at: 640,
      wait: 88.4,
      requestHeaders: [auth, { name: 'content-type', value: 'application/json' }],
      postData: {
        mimeType: 'application/json',
        text: JSON.stringify({ operationName: 'Notifications', query: 'query Notifications($first: Int!) { notifications(first: $first) { id kind title createdAt read } }', variables: { first: 5 } })
      },
      body: JSON.stringify({
        data: {
          notifications: [
            { id: 'n_31', kind: 'ORDER', title: 'Order #48207 was refunded', createdAt: '2026-11-15T08:12:40Z', read: false },
            { id: 'n_30', kind: 'REPORT', title: 'Weekly report is ready', createdAt: '2026-11-14T18:00:00Z', read: true }
          ]
        }
      }),
      initiator: stack('loadNotifications', 61, 'loadDashboard', 'setTimeout')
    },
    {
      url: 'https://api.example.com/v1/reports/export',
      method: 'POST',
      type: 'fetch',
      status: 500,
      statusText: 'Internal Server Error',
      mime: json,
      at: 812,
      wait: 1204.7,
      receive: 1.1,
      requestHeaders: [auth, { name: 'content-type', value: 'application/json' }, { name: 'x-provider-key', value: DEMO_SECRETS.providerKey }],
      postData: { mimeType: 'application/json', text: JSON.stringify({ report: 'revenue', range: '30d', format: 'csv', email: 'demo@example.com' }) },
      responseHeaders: [serverTiming(1102.4, 96.0), { name: 'x-request-id', value: 'req_7d1c4b90' }],
      body: JSON.stringify(
        {
          error: {
            code: 'report_timeout',
            message: 'The report service did not answer within 1200 ms.',
            requestId: 'req_7d1c4b90',
            retryable: true,
            details: { service: 'reports-worker', attempt: 3, upstream: 'https://reports.internal.example.com/run?token=rt_demo_77aa' }
          }
        },
        null,
        2
      ),
      initiator: stack('prefetchReports', 88, 'loadDashboard', 'await')
    },
    {
      url: 'https://api.example.com/v1/feature-flags?client=web',
      type: 'fetch',
      status: 404,
      statusText: 'Not Found',
      mime: json,
      at: 690,
      wait: 33.0,
      requestHeaders: [auth],
      body: '{"error":{"code":"not_found","message":"No route for GET /v1/feature-flags"}}',
      initiator: stack('loadFlags', 70, 'main', 'await')
    },
    {
      url: 'https://status.example.org/api/summary.json',
      type: 'fetch',
      status: 0,
      mime: 'x-unknown',
      at: 700,
      wait: 12.4,
      error: 'net::ERR_CONNECTION_REFUSED',
      initiator: stack('checkStatus', 102, 'main', 'setTimeout')
    },
    {
      url: `https://analytics.example.io/collect?v=2&tid=demo-web&api_key=${DEMO_SECRETS.analyticsKey}&ev=page_view&dl=%2Fdashboard`,
      method: 'POST',
      type: 'ping',
      status: 204,
      statusText: 'No Content',
      mime: 'text/plain',
      at: 980,
      wait: 41.9,
      connect: [14.0, 16.3, 22.8],
      size: 0,
      initiator: stack('track', 140, 'main', 'requestIdleCallback')
    },
    {
      url: 'https://app.example.com/assets/image-codec.wasm',
      type: 'wasm',
      mime: 'application/wasm',
      at: 760,
      wait: 21.0,
      receive: 12.5,
      // The smallest valid module: the magic number and version 1, built here byte by byte.
      bodyBase64: bytesToB64(new Uint8Array([0, ...[...'asm'].map((c) => c.charCodeAt(0)), 1, 0, 0, 0])),
      initiator: stack('loadCodec', 150, 'createChart', 'await')
    },
    {
      url: 'https://cdn.example.net/img/revenue-preview.png',
      type: 'img',
      mime: 'image/png',
      at: 880,
      wait: 26.2,
      receive: 4.8,
      bodyBase64: bytesToB64(demoPng()),
      initiator: stack('createChart', 12, 'loadDashboard', 'await')
    },
    {
      url: 'https://cdn.example.net/img/avatar-42.png',
      type: 'img',
      mime: 'image/png',
      at: 890,
      wait: 0,
      cache: 'memory',
      bodyBase64: bytesToB64(demoPng(48, 48)),
      initiator: parser(DOC, 12)
    },
    {
      url: 'https://cdn.example.net/media/onboarding.mp4',
      type: 'media',
      status: 206,
      statusText: 'Partial Content',
      mime: 'video/mp4',
      at: 1010,
      wait: 52.3,
      receive: 141.6,
      size: 1_048_576,
      responseHeaders: [{ name: 'content-range', value: 'bytes 0-1048575/6291456' }],
      initiator: parser(DOC, 30)
    },
    {
      url: 'wss://realtime.example.com/socket?v=3',
      type: 'ws',
      status: 101,
      statusText: 'Switching Protocols',
      mime: 'x-unknown',
      at: 1120,
      wait: 38.7,
      connect: [9.9, 12.1, 18.0],
      size: 0,
      requestHeaders: [
        { name: 'sec-websocket-key', value: 'dGhlIHNhbXBsZSBub25jZQ==' },
        { name: 'sec-websocket-version', value: '13' },
        { name: 'upgrade', value: 'websocket' }
      ],
      responseHeaders: [{ name: 'sec-websocket-accept', value: 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=' }],
      messages: wsMessages(rand),
      initiator: stack('connectRealtime', 120, 'main', 'await')
    },
    {
      url: 'https://api.example.com/v1/ai/summarize',
      method: 'POST',
      type: 'fetch',
      mime: json,
      at: 1400,
      wait: 512.3,
      receive: 22.6,
      requestHeaders: [auth, { name: 'content-type', value: 'application/json' }, { name: 'x-provider-key', value: DEMO_SECRETS.providerKey }],
      postData: { mimeType: 'application/json', text: JSON.stringify({ input: 'Revenue grew 6% week over week; refunds stayed flat.', maxWords: 40 }) },
      body: JSON.stringify({ summary: 'Revenue is up 6% this week with steady refunds.', model: 'demo-small', usage: { input: 18, output: 11 } }),
      initiator: stack('summarize', 175, 'loadDashboard', 'await')
    },
    { url: 'https://app.example.com/favicon.ico', type: 'other', mime: 'image/x-icon', at: 1900, wait: 11.2, size: 4286, initiator: { type: 'other' } }
  ]
  for (let i = 0; i < (options.extra ?? 0); i++) {
    const at = 2000 + i * 3 + Math.round(rand() * 40)
    const kind = i % 9
    const id = 48000 + i
    specs.push({
      url: kind === 8 ? `https://cdn.example.net/img/products/${id}.png` : `https://api.example.com/v1/orders/${id}?expand=items`,
      type: kind === 8 ? 'img' : 'fetch',
      mime: kind === 8 ? 'image/png' : json,
      status: kind === 5 && i % 45 === 5 ? 503 : 200,
      at,
      wait: 20 + Math.round(rand() * 300),
      requestHeaders: kind === 8 ? [] : [auth],
      size: kind === 8 ? 12_000 + Math.round(rand() * 40_000) : undefined,
      body: kind === 8 ? undefined : JSON.stringify({ id, customer: 'Demo Customer', total: Math.round(rand() * 50000) / 100, items: [{ sku: `SKU-${id}`, qty: 1 + (i % 3) }] }),
      initiator: stack('loadOrder', 210, 'loadDashboard', 'await')
    })
  }
  // Second page: the orders view.
  const P2 = 4200
  specs.push(
    {
      url: 'https://app.example.com/orders',
      type: 'doc',
      mime: 'text/html; charset=utf-8',
      at: P2,
      wait: 71.5,
      receive: 4.0,
      page: 'page_2',
      body: HTML.replace('Dashboard', 'Orders'),
      requestHeaders: [cookie]
    },
    { url: APP_CSS, type: 'css', mime: 'text/css', at: P2 + 96, wait: 0, cache: 'disk', page: 'page_2', body: CSS, initiator: parser('https://app.example.com/orders', 7) },
    { url: APP_JS, type: 'js', mime: 'application/javascript', at: P2 + 97, wait: 0, cache: 'disk', page: 'page_2', body: APP, initiator: parser('https://app.example.com/orders', 23) },
    {
      url: 'https://api.example.com/v1/orders?limit=50&status=all',
      type: 'fetch',
      mime: json,
      at: P2 + 260,
      wait: 196.2,
      receive: 9.9,
      page: 'page_2',
      requestHeaders: [auth],
      body: ordersBody(rand, 50),
      initiator: stack('loadOrders', 37, 'showOrders', 'await')
    },
    {
      url: 'https://api.example.com/v1/orders/48207/refund',
      method: 'POST',
      type: 'fetch',
      status: 409,
      statusText: 'Conflict',
      mime: json,
      at: P2 + 1300,
      wait: 77.7,
      page: 'page_2',
      requestHeaders: [auth, { name: 'content-type', value: 'application/x-www-form-urlencoded' }, { name: 'x-csrf-token', value: DEMO_SECRETS.csrf }],
      postData: { mimeType: 'application/x-www-form-urlencoded', text: `reason=duplicate&notify=1&csrf_token=${DEMO_SECRETS.csrf}` },
      body: '{"error":{"code":"already_refunded","message":"Order 48207 was refunded on 2026-11-15."}}',
      initiator: stack('refund', 330, 'onClick', 'click')
    }
  )
  specs.sort((a, b) => a.at - b.at)
  const entries = specs.map((spec) => toEntry(spec, rand))
  const pages: HarPage[] = [
    { startedDateTime: iso(T0), id: 'page_1', title: 'https://app.example.com/dashboard', pageTimings: { onContentLoad: 486.3, onLoad: 1312.8 } },
    { startedDateTime: iso(T0 + P2), id: 'page_2', title: 'https://app.example.com/orders', pageTimings: { onContentLoad: 241.9, onLoad: 702.4 } }
  ]
  return { log: { version: '1.2', creator: { name: 'WebInspector', version: '537.36' }, browser: { name: 'Chrome', version: '131.0.6778.86' }, pages, entries } }
}

function wsMessages(rand: () => number): HarWebSocketMessage[] {
  const base = (T0 + 1160) / 1000
  const list: HarWebSocketMessage[] = [
    { type: 'send', time: base, opcode: 1, data: JSON.stringify({ type: 'auth', token: DEMO_SECRETS.jwt }) },
    { type: 'receive', time: base + 0.041, opcode: 1, data: JSON.stringify({ type: 'ready', session: 'rt_5521', heartbeat: 15 }) },
    { type: 'send', time: base + 0.05, opcode: 1, data: JSON.stringify({ type: 'subscribe', channels: ['orders', 'metrics'] }) }
  ]
  let t = base + 0.3
  for (let i = 0; i < 14; i++) {
    t += 0.4 + rand() * 1.6
    list.push(
      i % 5 === 4
        ? { type: 'receive', time: t, opcode: 1, data: JSON.stringify({ type: 'order.created', order: { id: 48211 + i, total: Math.round(rand() * 30000) / 100 } }) }
        : { type: 'receive', time: t, opcode: 1, data: JSON.stringify({ type: 'metrics.tick', revenue: 21000 + Math.round(rand() * 900), activeUsers: 120 + Math.round(rand() * 40) }) }
    )
  }
  list.push({ type: 'send', time: t + 0.2, opcode: 9, data: '' }, { type: 'receive', time: t + 0.24, opcode: 10, data: '' })
  return list
}
