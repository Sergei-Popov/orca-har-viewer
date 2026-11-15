import { assert, test } from 'orca/testing'
import { DEMO_SECRETS, demoHar } from '../fixtures/demo'
import { shellQuote, toCurl, toFetch } from './copy'
import { buildDigest } from './digest'
import { buildModel } from './model'
import { MASK, sanitizeHar } from './sanitize'
import type { HarEntry } from './types'

const post: HarEntry = {
  request: {
    method: 'POST',
    url: "https://api.example.com/v1/items?q=it's",
    headers: [
      { name: ':authority', value: 'api.example.com' },
      { name: 'content-type', value: 'application/json' },
      { name: 'accept-encoding', value: 'gzip, br' },
      { name: 'cookie', value: 'a=1' },
      { name: 'content-length', value: '12' },
      { name: 'referer', value: 'https://app.example.com/' },
      { name: 'sec-fetch-mode', value: 'cors' }
    ],
    postData: { mimeType: 'application/json', text: '{"name":"it\'s"}' }
  },
  response: { status: 201 }
}

test('shell quoting: plain, single quotes, control characters', () => {
  assert.equal(shellQuote('abc'), `'abc'`)
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
  assert.equal(shellQuote('a\nb\\c'), `$'a\\nb\\\\c'`)
  assert.equal(shellQuote('tab\there'), `$'tab\\there'`)
})

test('Copy as cURL', () => {
  const curl = toCurl(post)
  assert.equal(
    curl,
    [
      `curl 'https://api.example.com/v1/items?q=it'\\''s'`,
      `-H 'content-type: application/json'`,
      `-b 'a=1'`,
      `-H 'referer: https://app.example.com/'`,
      `-H 'sec-fetch-mode: cors'`,
      `--data-raw '{"name":"it'\\''s"}'`,
      '--compressed'
    ].join(' \\\n  ')
  )
  const put = toCurl({ request: { method: 'PUT', url: 'https://e.com/x', headers: [] } })
  assert.equal(put, `curl 'https://e.com/x' \\\n  -X 'PUT'`)
  assert.equal(toCurl({ request: { method: 'GET', url: 'https://e.com/' } }), `curl 'https://e.com/'`)
})

test('Copy as fetch', () => {
  const code = toFetch(post)
  assert.ok(code.startsWith('fetch("https://api.example.com/v1/items?q=it\'s", {'))
  const init = JSON.parse(code.slice(code.indexOf(', ') + 2, -2))
  assert.deepEqual(init.headers, { 'content-type': 'application/json' })
  assert.equal(init.referrer, 'https://app.example.com/')
  assert.equal(init.body, '{"name":"it\'s"}')
  assert.equal(init.method, 'POST')
  assert.equal(init.credentials, 'include')
})

test('cURL and fetch of a masked entry hold no secrets', () => {
  const masked = sanitizeHar(demoHar()).har
  for (const entry of masked.log.entries!) {
    for (const text of [toCurl(entry), toFetch(entry)]) {
      for (const secret of Object.values(DEMO_SECRETS)) assert.ok(!text.includes(secret), `${entry.request?.url}: ${secret}`)
    }
  }
})

test('agent digest: chosen requests, masked, bodies cut, noise left out', () => {
  const masked = buildModel(sanitizeHar(demoHar()).har)
  const failed = masked.entries.filter((e) => e.isError)
  const digest = buildDigest(masked, failed, { title: '4 failed requests', bodies: true, maxBody: 120 })
  assert.ok(digest.startsWith('# HAR digest: 4 failed requests\n'))
  assert.ok(digest.includes('- Source: WebInspector 537.36 · Chrome 131.0.6778.86 · '))
  assert.ok(digest.includes('## 1. GET https://api.example.com/v1/feature-flags?client=web → 404 Not Found'))
  assert.ok(digest.includes('→ failed (net::ERR_CONNECTION_REFUSED)'))
  assert.ok(digest.includes('POST https://api.example.com/v1/reports/export → 500 Internal Server Error'))
  assert.ok(digest.includes(`authorization: Bearer ${MASK}`))
  assert.ok(digest.includes('more characters)'), 'long bodies are cut')
  assert.ok(digest.includes('```json\n{\n  "error": {'), 'JSON bodies are pretty-printed')
  assert.ok(!digest.includes('sec-ch-ua'), 'routine headers are left out')
  assert.ok(digest.includes('routine ones left out'))
  for (const secret of Object.values(DEMO_SECRETS)) assert.ok(!digest.includes(secret), secret)
  const short = buildDigest(masked, failed.slice(0, 1), { title: '1 request', bodies: false })
  assert.ok(!short.includes('Response body'))
  assert.ok(short.includes('Bodies are left out.'))
})

test('agent digest: WebSocket frames, binary bodies and fences around backticks', () => {
  const model = buildModel(demoHar())
  const ws = model.entries.find((e) => e.type === 'ws')!
  const png = model.entries.find((e) => e.url.includes('revenue-preview.png'))!
  const digest = buildDigest(model, [ws, png], { title: '2 requests', bodies: true })
  assert.ok(digest.includes('WebSocket messages (19):'))
  assert.ok(digest.includes('→ {"type":"subscribe"'))
  assert.ok(digest.includes('Response body: binary (image/png'))
  const tricky = buildModel({
    log: { entries: [{ request: { method: 'GET', url: 'https://e.com/readme' }, response: { status: 200, content: { mimeType: 'text/markdown', text: 'a\n```js\nx\n```\n' } } }] }
  })
  assert.ok(buildDigest(tricky, tricky.entries, { title: 'x', bodies: true }).includes('````text\na\n```js'))
})
