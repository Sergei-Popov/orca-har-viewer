import { assert, test } from 'orca/testing'
import { demoHar } from '../fixtures/demo'
import { buildModel, parseTime, splitUrl } from './model'
import { readHar } from './read'
import type { HarEntry } from './types'

test('a valid HAR reads as is', () => {
  const text = JSON.stringify(demoHar())
  const result = readHar(text)
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.issue, undefined)
  assert.equal(result.har.log.entries!.length, demoHar().log.entries!.length)
  assert.equal(readHar(`﻿${text}`).ok, true, 'a byte order mark is skipped')
})

test('empty, not JSON, and JSON that is not a HAR', () => {
  const empty = readHar('  \n')
  assert.ok(!empty.ok && empty.reason === 'empty')
  const html = readHar('<!doctype html><title>x</title>')
  assert.ok(!html.ok && html.reason === 'not-json')
  const other = readHar('{"name":"package","version":"1.0.0"}')
  assert.ok(!other.ok && other.reason === 'not-har')
})

test('lenient shapes: { entries } and a bare array of entries', () => {
  const entry = { request: { method: 'GET', url: 'https://example.com/' }, response: { status: 200 } }
  const a = readHar(JSON.stringify({ entries: [entry] }))
  assert.ok(a.ok && a.har.log.entries!.length === 1)
  const b = readHar(JSON.stringify([entry, entry]))
  assert.ok(b.ok && b.har.log.entries!.length === 2)
})

test('a cut-off file shows the entries before the cut', () => {
  const text = JSON.stringify(demoHar(), null, 2)
  const cut = text.slice(0, Math.floor(text.length * 0.6))
  const result = readHar(cut)
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.issue?.kind, 'truncated')
  assert.ok(result.issue!.recovered > 5)
  assert.equal(result.issue!.skipped, 1, 'the entry the file ends inside of')
  assert.equal(result.har.log.entries!.length, result.issue!.recovered)
  assert.equal(result.har.log.pages!.length, 2)
  assert.equal(result.har.log.creator?.name, 'WebInspector')
  assert.equal(result.har.log.version, '1.2')
  // Every recovered entry is whole.
  for (const entry of result.har.log.entries!) assert.ok(entry.request?.url && entry.timings)
})

test('a file broken in the middle keeps the entries around the damage', () => {
  const har = demoHar()
  const text = JSON.stringify(har)
  // Break the third entry's JSON (a stray character) without unbalancing anything.
  const third = JSON.stringify(har.log.entries![2])
  const broken = text.replace(third, third.replace('"request":', '"request" x:'))
  const result = readHar(broken)
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.issue?.kind, 'invalid')
  assert.equal(result.issue!.skipped, 1)
  assert.equal(result.har.log.entries!.length, har.log.entries!.length - 1)
  assert.ok(result.issue!.line >= 1 && result.issue!.column > 1)
})

test('trailing garbage after a whole HAR keeps everything', () => {
  const har = demoHar()
  const result = readHar(`${JSON.stringify(har)}\n\u0000\u0000garbage`)
  assert.ok(result.ok && result.issue?.kind === 'invalid')
  if (result.ok) assert.equal(result.har.log.entries!.length, har.log.entries!.length)
})

test('the model: numbers worked out once per entry', () => {
  const model = buildModel(demoHar())
  assert.equal(model.creator, 'WebInspector 537.36 · Chrome 131.0.6778.86')
  assert.equal(model.pages.length, 2)
  assert.equal(model.pages[0].onContentLoad, 486.3)
  assert.ok(model.hasInitiator)
  const byUrl = (part: string) => model.entries.find((e) => e.url.includes(part))!
  const doc = byUrl('/dashboard')
  assert.equal(doc.status, 301)
  assert.equal(doc.type, 'doc')
  const failed = byUrl('status.example.org')
  assert.ok(failed.failed && failed.isError)
  assert.equal(failed.error, 'net::ERR_CONNECTION_REFUSED')
  assert.equal(byUrl('/reports/export').status, 500)
  assert.equal(byUrl('/reports/export').statusText, 'Internal Server Error')
  assert.ok(byUrl('/reports/export').isError)
  assert.equal(byUrl('socket').type, 'ws')
  assert.equal(byUrl('.wasm').type, 'wasm')
  assert.equal(byUrl('inter-var').type, 'font')
  assert.equal(byUrl('avatar-42').cache, 'memory')
  assert.equal(byUrl('avatar-42').transferSize, 0)
  const metrics = byUrl('/metrics')
  assert.equal(metrics.host, 'api.example.com')
  assert.equal(metrics.path, '/v1/metrics?range=7d&tz=UTC')
  assert.equal(metrics.name, 'metrics?range=7d&tz=UTC')
  assert.equal(metrics.initiator, 'app.3f9a2c.js:212')
  assert.equal(metrics.initiatorType, 'script')
  assert.ok(metrics.timings.wait > 200)
  assert.equal(model.domains[0].host, 'app.example.com')
  assert.ok(model.domains.every((d, i) => i === 0 || model.domains[i - 1].count >= d.count))
  assert.ok(model.end > model.start)
})

test('missing and -1 timings, entries without pages, Firefox-style sizes', () => {
  const entry: HarEntry = {
    startedDateTime: '2026-11-15T10:00:00.123456+00:00',
    request: { method: 'get', url: 'https://example.com/a.css' },
    response: { status: 200, content: { mimeType: 'text/css', text: 'a{}' }, headersSize: 120, bodySize: 30 },
    timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 1, wait: 9, receive: 2 }
  }
  const model = buildModel({ log: { entries: [entry] } })
  const e = model.entries[0]
  assert.equal(e.method, 'GET')
  assert.equal(e.type, 'css')
  assert.equal(e.time, 12)
  assert.equal(e.timings.dns, -1)
  assert.equal(e.transferSize, 150)
  assert.equal(e.resourceSize, 3)
  assert.equal(e.pageId, '')
  assert.equal(model.pages.length, 0)
  assert.ok(Math.abs(e.start - (Date.UTC(2026, 10, 15, 10, 0, 0, 123) + 0.456)) < 1e-6)
})

test('URLs: names, data URLs and broken URLs', () => {
  assert.deepEqual(splitUrl('https://example.com/'), { scheme: 'https', host: 'example.com', path: '/', name: 'example.com' })
  assert.equal(splitUrl('https://example.com:8443/a/b%20c.js?x=1').name, 'b c.js?x=1')
  assert.equal(splitUrl('https://example.com:8443/a').host, 'example.com:8443')
  assert.equal(splitUrl('data:image/png;base64,AAAA').scheme, 'data')
  assert.equal(splitUrl('not a url').host, '')
  assert.ok(Number.isNaN(parseTime('yesterday')))
})

test('classification without Chrome fields: Sec-Fetch-Dest, MIME, extension, WebSocket upgrade', () => {
  const make = (url: string, mime: string, headers: { name: string; value: string }[] = []): HarEntry => ({
    request: { method: 'GET', url, headers },
    response: { status: 200, content: { mimeType: mime } }
  })
  const model = buildModel({
    log: {
      entries: [
        make('https://e.com/api', 'application/json'),
        make('https://e.com/page', 'text/html', [{ name: 'Sec-Fetch-Dest', value: 'document' }]),
        make('https://e.com/x', 'text/html', [{ name: 'Sec-Fetch-Dest', value: 'empty' }]),
        make('https://e.com/s.mjs', ''),
        make('https://e.com/i', 'image/webp'),
        make('https://e.com/f.woff2', 'application/octet-stream'),
        make('https://e.com/v', 'video/mp4'),
        make('https://e.com/ws', '', [{ name: 'Upgrade', value: 'websocket' }]),
        make('https://e.com/m.wasm', 'application/octet-stream'),
        make('https://e.com/blob', 'application/octet-stream')
      ]
    }
  })
  assert.deepEqual(
    model.entries.map((e) => e.type),
    ['fetch', 'doc', 'fetch', 'js', 'img', 'font', 'media', 'ws', 'wasm', 'other']
  )
})
