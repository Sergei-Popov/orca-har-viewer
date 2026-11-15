import { assert, test } from 'orca/testing'
import { demoHar } from '../fixtures/demo'
import { buildModel, parseTime, splitUrl } from './model'
import { jsonError, lineColumn, plainMessage, readHar } from './read'
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

test('JSON.parse messages lose the position the viewer shows as a line and column', () => {
  assert.equal(plainMessage("Expected ',' or '}' after property value in JSON at position 157328 (line 2959 column 32)"), "Expected ',' or '}' after property value")
  assert.equal(plainMessage(`Unexpected token ']', ..."s":200}},\n]}}\n" is not valid JSON`), "Unexpected token ']'")
  assert.equal(plainMessage(`Unexpected token ']', "[1,]" is not valid JSON`), "Unexpected token ']'")
  assert.equal(plainMessage('Unexpected end of JSON input'), 'Unexpected end of JSON input')
  assert.equal(plainMessage('Unexpected token } in JSON at position 12'), 'Unexpected token }')
  const result = readHar('This is a plain text file.\n')
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'not-json')
    assert.ok(!/position \d/.test(result.message), result.message)
    assert.equal(result.line, 1)
  }
})

/** demo.har pretty-printed, with one edit made where `find` first occurs (after `from`). */
function damage(find: string, replace: string, from = 0): { text: string; at: number } {
  const text = JSON.stringify(demoHar(), null, 2)
  const at = text.indexOf(find, from)
  assert.ok(at >= 0, find)
  return { text: text.slice(0, at) + replace + text.slice(at + find.length), at }
}

test('review 12: syntax errors are reported where they are, not as a cut at the end', () => {
  const total = demoHar().log.entries!.length
  const lastEntryEnd = JSON.stringify(demoHar(), null, 2).lastIndexOf('      }\n    ]')
  const cases: { name: string; edit: { text: string; at: number }; recovered: number; skipped: number; offset: number }[] = []
  const comma = damage('      }\n    ]', '      },\n    ]', lastEntryEnd)
  cases.push({ name: 'trailing comma', edit: comma, recovered: total, skipped: 0, offset: comma.text.indexOf(']', comma.at) })
  const nan = damage('"time": ', '"time": NaN, "was": ')
  cases.push({ name: 'NaN', edit: nan, recovered: total - 1, skipped: 1, offset: nan.at + 8 })
  const single = damage('"method": "GET"', `"method": 'GET'`)
  cases.push({ name: 'single quotes', edit: single, recovered: total - 1, skipped: 1, offset: single.at + 10 })
  const comment = damage('"entries": [\n      {', '"entries": [\n      // the first request\n      {')
  cases.push({ name: 'a comment line', edit: comment, recovered: total, skipped: 0, offset: comment.text.indexOf('//', comment.at) })
  for (const c of cases) {
    const result = readHar(c.edit.text)
    assert.ok(result.ok, c.name)
    if (!result.ok) continue
    assert.equal(result.issue?.kind, 'invalid', c.name)
    assert.deepEqual([result.issue!.recovered, result.issue!.skipped], [c.recovered, c.skipped], c.name)
    const where = lineColumn(c.edit.text, c.offset)
    assert.deepEqual([result.issue!.line, result.issue!.column], [where.line, where.column], c.name)
    assert.ok(!result.issue!.message.includes('is not valid JSON'), c.name)
  }
  // A real cut is still a cut, also inside a string.
  const text = JSON.stringify(demoHar(), null, 2)
  const cut = readHar(text.slice(0, text.indexOf('"url": "') + 20))
  assert.ok(cut.ok && cut.issue?.kind === 'truncated')
  assert.deepEqual(jsonError('[1, "ab'), { offset: 7, eof: true })
  assert.deepEqual(jsonError('[1, 2]  x'), { offset: 8, eof: false })
  assert.equal(jsonError(' {"a": [1, -2.5e+3, true, null, "\\u00e9\\n"]} '), null)
})

test('review 12: a lost quote counts every request it hides, and nothing else poses as one', () => {
  const total = demoHar().log.entries!.length
  // The opening quote of the third entry's "url" key.
  let from = 0
  for (let k = 0; k < 3; k++) from = JSON.stringify(demoHar(), null, 2).indexOf('"request": {', from) + 1
  const lost = damage('"url"', 'url"', from)
  const result = readHar(lost.text)
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.issue?.kind, 'invalid')
  assert.equal(result.issue!.recovered + result.issue!.skipped, total)
  assert.equal(result.har.log.entries!.length, result.issue!.recovered)
  for (const entry of result.har.log.entries!) assert.ok(entry.request && typeof entry.request === 'object', 'no header objects as entries')
  assert.equal(lineColumn(lost.text, lost.at).line, result.issue!.line)
})

test('review 14: base64 padding is measured without a regex, so a run of = cannot stall opening', () => {
  const entry = (text: string): HarEntry => ({
    request: { method: 'GET', url: 'https://x.example.com/a.png' },
    response: { status: 200, content: { mimeType: 'image/png', encoding: 'base64', text } }
  })
  const start = performance.now()
  const model = buildModel({ log: { entries: [entry(`${'='.repeat(200_000)}A`), entry('QUJD'), entry('QQ==')] } })
  assert.ok(performance.now() - start < 200)
  assert.deepEqual(model.entries.slice(1).map((e) => e.resourceSize), [3, 1])
})

test('review 17: one entry with a field of an unexpected type does not fail the file', () => {
  const ok = (path: string): HarEntry => ({ request: { method: 'GET', url: `https://x.example.com/${path}` }, response: { status: 200 } })
  const odd = [
    { request: { method: 'GET', url: 'https://x.example.com/mime-number' }, response: { status: 200, content: { mimeType: 0 } } },
    { request: { method: 'GET', url: 'https://x.example.com/mime-object' }, response: { status: 200, content: { mimeType: {} } } },
    { request: { method: 'GET', url: 'https://x.example.com/frames-object' }, _initiator: { type: 'script', stack: { callFrames: {} } } },
    { request: { method: 'GET', url: 'https://x.example.com/frames-string', httpVersion: 2 }, _initiator: { type: 'script', stack: { callFrames: 'x', parent: 'y' } } }
  ] as unknown as HarEntry[]
  const model = buildModel({ log: { entries: [ok('first'), ...odd, ok('last')] } })
  assert.deepEqual(
    model.entries.map((e) => e.url.split('/').pop()),
    ['first', 'mime-number', 'mime-object', 'frames-object', 'frames-string', 'last']
  )
  assert.equal(model.entries[4].httpVersion, '')
})
