import { assert, test } from 'orca/testing'
import { zipSync } from '../../vendor/fflate/fflate.mjs'
import { demoHar, demoPng } from '../fixtures/demo'
import { decodeBase64, encodeBase64, isTextual, looksLikeText, requestBody, responseBody, viewKind } from './body'
import { inflate, isZip, openHarZip, ZipError } from './zip'
import type { Har } from './types'

const enc = new TextEncoder()

/** A .har.zip the way Playwright writes it in "attach" mode. */
function playwrightZip(): Uint8Array {
  const har: Har = {
    log: {
      version: '1.2',
      creator: { name: 'Playwright', version: '1.49.0' },
      browser: { name: 'chromium', version: '131.0.6778.33' },
      pages: [{ startedDateTime: '2026-11-15T10:00:00.000Z', id: 'page@1', title: 'Demo', pageTimings: { onContentLoad: 120, onLoad: 300 } }],
      entries: [
        {
          pageref: 'page@1',
          startedDateTime: '2026-11-15T10:00:00.010Z',
          time: 40,
          request: {
            method: 'POST',
            url: 'https://api.example.com/v1/items',
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            queryString: [],
            postData: { mimeType: 'application/json', _file: 'b1.json' },
            headersSize: -1,
            bodySize: 11
          },
          response: {
            status: 200,
            statusText: 'OK',
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            content: { size: 17, mimeType: 'application/json', _file: 'a1.json' },
            headersSize: -1,
            bodySize: -1,
            redirectURL: '',
            _transferSize: 120
          },
          cache: {},
          timings: { send: 1, wait: 30, receive: 9 }
        },
        {
          startedDateTime: '2026-11-15T10:00:00.020Z',
          time: 10,
          request: { method: 'GET', url: 'https://cdn.example.com/chart.png', headers: [] },
          response: { status: 200, content: { size: 10, mimeType: 'image/png', _file: 'c1.png' } },
          timings: { send: 1, wait: 5, receive: 4 }
        },
        {
          startedDateTime: '2026-11-15T10:00:00.030Z',
          time: 10,
          request: { method: 'GET', url: 'https://cdn.example.com/gone.js', headers: [] },
          response: { status: 200, content: { size: 10, mimeType: 'text/javascript', _file: 'missing.js' } },
          timings: { send: 1, wait: 5, receive: 4 }
        }
      ]
    }
  }
  return zipSync({
    'har.har': enc.encode(JSON.stringify(har)),
    'a1.json': enc.encode('{"id":1,"ok":true}'),
    'b1.json': [enc.encode('{"name":"x"}'), { level: 0 }],
    'c1.png': demoPng(8, 8)
  })
}

test('a Playwright .har.zip: the HAR and its body files', () => {
  const bytes = playwrightZip()
  assert.ok(isZip(bytes))
  const zip = openHarZip(bytes)
  assert.equal(zip.name, 'har.har')
  assert.deepEqual([...zip.names].sort(), ['a1.json', 'b1.json', 'c1.png', 'har.har'])
  const har = JSON.parse(zip.text) as Har
  const [first, second, third] = har.log.entries!
  const response = responseBody(first, zip.files)
  assert.ok(response.kind === 'text' && response.text === '{"id":1,"ok":true}' && response.file === 'a1.json')
  const request = requestBody(first, zip.files)
  assert.ok(request.kind === 'text' && request.text === '{"name":"x"}', 'stored (level 0) files read too')
  const image = responseBody(second, zip.files)
  assert.ok(image.kind === 'bytes' && image.bytes[1] === 0x50)
  const missing = responseBody(third, zip.files)
  assert.ok(missing.kind === 'none' && missing.reason === 'missing-file')
  const outside = responseBody(first)
  assert.ok(outside.kind === 'none' && outside.reason === 'external-file', 'a plain .har pointing at body files')
})

test('ZIP errors: not a zip, no .har inside, cut off', () => {
  const code = (fn: () => unknown) => {
    try {
      fn()
    } catch (error) {
      return error instanceof ZipError ? error.code : 'other'
    }
    return 'none'
  }
  assert.equal(code(() => openHarZip(enc.encode('{"log":{}}'))), 'not-zip')
  assert.equal(code(() => openHarZip(zipSync({ 'readme.txt': enc.encode('hi') }))), 'no-har')
  const bytes = playwrightZip()
  assert.equal(code(() => openHarZip(bytes.subarray(0, bytes.length - 30))), 'damaged')
  // A .har somewhere else than har.har is found too.
  assert.equal(openHarZip(zipSync({ 'logs/session.har': enc.encode('{"log":{"entries":[]}}') })).name, 'logs/session.har')
})

test('DEFLATE stops at the declared size instead of running on', () => {
  const big = new Uint8Array(200_000).fill(65)
  const zipped = zipSync({ 'har.har': big })
  // The raw DEFLATE stream of the single file starts after the 30-byte local header and name.
  const nameLength = zipped[26] | (zipped[27] << 8)
  const packed = zipped[18] | (zipped[19] << 8) | (zipped[20] << 16) | (zipped[21] << 24)
  const data = zipped.subarray(30 + nameLength, 30 + nameLength + packed)
  assert.equal(inflate(data, 200_000).length, 200_000)
  let error: unknown
  try {
    inflate(data, 1000)
  } catch (e) {
    error = e
  }
  assert.ok(error instanceof ZipError && error.code === 'damaged')
})

test('bodies: base64, charsets, sniffing and view kinds', () => {
  const text = 'Привет, мир'
  const win1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])
  const body = responseBody({ response: { content: { mimeType: 'text/plain; charset=windows-1251', text: encodeBase64(win1251), encoding: 'base64' } } })
  assert.ok(body.kind === 'text' && body.text === 'Привет' && body.base64)
  const utf8 = responseBody({ response: { content: { mimeType: 'application/json', text: encodeBase64(enc.encode(`"${text}"`)), encoding: 'base64' } } })
  assert.ok(utf8.kind === 'text' && utf8.text === `"${text}"`)
  assert.deepEqual(decodeBase64('AQID'), new Uint8Array([1, 2, 3]))
  assert.deepEqual(decodeBase64('AQI'), new Uint8Array([1, 2]), 'missing padding')
  assert.deepEqual(decodeBase64('-_8'), new Uint8Array([0xfb, 0xff]), 'URL-safe alphabet')
  assert.equal(decodeBase64('***'), null)
  const none = responseBody({ response: { content: { size: 120, mimeType: 'text/html' } } })
  assert.ok(none.kind === 'none' && none.reason === 'not-recorded')
  const form = requestBody({ request: { postData: { mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'a b', value: 'c&d' }] } } })
  assert.ok(form.kind === 'text' && form.text === 'a%20b=c%26d')
  assert.ok(looksLikeText(enc.encode('hello\nworld')))
  assert.ok(!looksLikeText(demoPng(4, 4)))
  assert.ok(isTextual('application/problem+json') && isTextual('image/svg+xml') && !isTextual('image/png'))
  assert.equal(viewKind('application/vnd.api+json'), 'json')
  assert.equal(viewKind('text/plain', '{"a":1}'), 'json')
  assert.equal(viewKind('text/plain', '<!DOCTYPE html><p>'), 'html')
  assert.equal(viewKind('text/javascript'), 'js')
  assert.equal(viewKind('image/svg+xml'), 'image')
  assert.equal(viewKind('font/woff2'), 'font')
  assert.equal(viewKind('application/octet-stream'), 'binary')
})

test('every body of the demo HAR decodes', () => {
  for (const entry of demoHar().log.entries!) {
    const body = responseBody(entry)
    assert.ok(body.kind !== 'text' || typeof body.text === 'string')
  }
})
