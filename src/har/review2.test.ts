// Regression tests for the findings of the 0.1.0 round-2 review (numbers in the test names).
// Every fixture is built here from obviously fake values; tokens a secret scanner knows are
// assembled from pieces, and random-looking values come from a seeded generator.

import { assert, test } from 'orca/testing'
import { zipSync } from '../../vendor/fflate/fflate.mjs'
import { encodeBase64, requestBody, responseBody, type SideFiles } from './body'
import { buildDigest } from './digest'
import { responseCookies } from './headers'
import { maskedHarText, maskedHarZip, maskedHarZipSteps, maskRecording, maskSteps, runSteps, runStepsAsync } from './masked'
import { isRandom } from './mask-text'
import { buildModel } from './model'
import { formFields, queryFields } from './fields'
import { Haystacks } from './query'
import { MASK, maskBodyBytes, maskBodyText, maskHeaderValue, maskText, maskUrl, sanitizeHar, type Counter } from './sanitize'
import type { Har, HarEntry } from './types'
import { stringsFor } from '../i18n'
import { openError } from '../open-errors'
import { openHarZip, ZipError } from './zip'

const enc = new TextEncoder()
const dec = new TextDecoder()

function counter(): Counter & { n: number } {
  const c = {
    n: 0,
    add(_kind: string, count = 1) {
      c.n += count
    }
  }
  return c
}

/** Base64url characters from a seeded generator: random-looking, the same on every run. */
function randomToken(seed: number, length = 32): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let state = seed >>> 0 || 1
  let out = ''
  while (out.length < length) {
    state = (state * 1664525 + 1013904223) >>> 0
    out += alphabet[state >>> 26]
  }
  // At least one digit and one letter, as the catch-all asks.
  return `${out.slice(0, -2)}7q`
}

function entry(partial: Partial<HarEntry> = {}): HarEntry {
  return {
    startedDateTime: '2026-11-15T10:00:00.000Z',
    time: 10,
    request: { method: 'GET', url: 'https://api.example.com/v1/items', httpVersion: 'h2', headers: [], cookies: [], queryString: [] },
    response: { status: 200, statusText: 'OK', headers: [], cookies: [], content: { size: 0, mimeType: 'application/json' } },
    timings: { send: 1, wait: 5, receive: 4 },
    ...partial
  }
}

function har(entries: HarEntry[], extra: Partial<Har['log']> = {}): Har {
  return { log: { version: '1.2', creator: { name: 'test', version: '1' }, entries, ...extra } }
}

const SECRET = 'S3cretValue-0001'

test('review 1: the Payload tab decodes every query value and form field exactly once', () => {
  // Chrome writes queryString encoded, Firefox and Playwright decoded: the URL decides.
  const url = 'https://shop.example.com/search?q=50%25%20off&tag=a%2Bb&plus=1+2'
  const chrome = entry({ request: { method: 'GET', url, queryString: [{ name: 'q', value: '50%25%20off' }, { name: 'tag', value: 'a%2Bb' }, { name: 'plus', value: '1+2' }] } })
  const firefox = entry({ request: { method: 'GET', url, queryString: [{ name: 'q', value: '50% off' }, { name: 'tag', value: 'a+b' }, { name: 'plus', value: '1 2' }] } })
  const expected = [
    ['q', '50% off'],
    ['tag', 'a+b'],
    ['plus', '1 2']
  ]
  assert.deepEqual(queryFields(chrome, url), expected)
  assert.deepEqual(queryFields(firefox, url), expected)
  // A value that merely looks encoded stays as it was sent.
  const literal = 'https://shop.example.com/p?code=%2541'
  assert.deepEqual(queryFields(entry({ request: { method: 'GET', url: literal, queryString: [{ name: 'code', value: '%41' }] } }), literal), [['code', '%41']])
  // URL-only recordings (no queryString list) and a query after a hash route.
  assert.deepEqual(queryFields(entry({ request: { method: 'GET', url: 'https://x.example.com/?a=%C3%A9' } }), 'https://x.example.com/?a=%C3%A9'), [['a', 'é']])
  assert.deepEqual(queryFields(entry({ request: { method: 'GET', url: 'https://x.example.com/#/r?a=1' } }), 'https://x.example.com/#/r?a=1'), [])

  // Form fields come from the body text, decoded once: Chrome's encoded params and Playwright's decoded ones agree.
  const text = 'note=x%26y&sum=1+2&pct=100%25'
  const form = (params: { name: string; value: string }[]) =>
    formFields(entry({ request: { method: 'POST', url: 'https://x.example.com/f', postData: { mimeType: 'application/x-www-form-urlencoded', text, params } } }))
  const fields = [
    ['note', 'x&y'],
    ['sum', '1 2'],
    ['pct', '100%']
  ]
  assert.deepEqual(form([{ name: 'note', value: 'x%26y' }, { name: 'sum', value: '1+2' }, { name: 'pct', value: '100%25' }]), fields)
  assert.deepEqual(form([{ name: 'note', value: 'x&y' }, { name: 'sum', value: '1 2' }, { name: 'pct', value: '100%' }]), fields)
  // Without the text (multipart, a body kept in a separate file) the params are shown as written.
  const multipart = entry({
    request: { method: 'POST', url: 'https://x.example.com/u', postData: { mimeType: 'multipart/form-data; boundary=b', params: [{ name: 'pct', value: '100%' }, { name: 'file', fileName: 'a.png', contentType: 'image/png' }] } }
  })
  assert.deepEqual(formFields(multipart), [
    ['pct', '100%'],
    ['file', 'a.png (image/png)']
  ])
  // Fields of a type no recorder writes do not throw.
  const odd = entry({ request: { method: 'POST', url: 'https://x.example.com/u', queryString: { a: 1 } as never, postData: { mimeType: 'text/plain', params: [{ name: 'n', value: 5 as never }] } } })
  assert.deepEqual(queryFields(odd, 'https://x.example.com/u'), [])
  assert.deepEqual(formFields(odd), [['n', '5']])
})

test('review 2: folded Set-Cookie values and cookies without a name are masked; Expires dates stay', () => {
  const folded = `theme=dark; Path=/, session=${SECRET}; Path=/; HttpOnly; Secure`
  assert.equal(maskHeaderValue('Set-Cookie', folded, counter()), `theme=${MASK}; Path=/, session=${MASK}; Path=/; HttpOnly; Secure`)
  const dated = `a=${SECRET}; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, sid=${SECRET}; Path=/`
  assert.equal(maskHeaderValue('set-cookie', dated, counter()), `a=${MASK}; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, sid=${MASK}; Path=/`)
  assert.equal(maskHeaderValue('Set-Cookie', `${SECRET}; Path=/`, counter()), `${MASK}; Path=/`)
  assert.equal(maskHeaderValue('Cookie', `${SECRET}; b=2`, counter()), `${MASK}; b=${MASK}`)
  // Lines and folds together, as some recorders join them.
  const lines = maskHeaderValue('Set-Cookie', `a=1, b=2\nc=3`, counter())
  assert.equal(lines, `a=${MASK}, b=${MASK}\nc=${MASK}`)
  // The Cookies tab reads the folded header as two cookies.
  const cookies = responseCookies([], [{ name: 'Set-Cookie', value: dated }])
  assert.deepEqual(
    cookies.map((c) => [c.name, c.expires ?? '']),
    [
      ['a', 'Wed, 21 Oct 2026 07:28:00 GMT'],
      ['sid', '']
    ]
  )
  // And the saved file holds none of them.
  const saved = maskedHarText(maskRecording(har([entry({ response: { status: 200, headers: [{ name: 'Set-Cookie', value: folded }, { name: 'set-cookie', value: `${SECRET}; Path=/` }] } })])))
  assert.ok(!saved.includes(SECRET))
})

test('review 3: Socket.IO long-polling: Engine.IO 4 packet runs, Engine.IO 3 framing and binary events', () => {
  const mime = 'text/plain;charset=UTF-8'
  const eio4 = `42["login",{"user":"a","pin":13579}]\u001e42["message","{\\"token\\":\\"${SECRET}\\"}"]`
  const out4 = maskBodyText(eio4, mime, counter())
  assert.ok(!out4.includes('13579') && !out4.includes(SECRET), out4)
  assert.equal(out4.split('\u001e').length, 2)
  // Engine.IO 3: `length:packet`, lengths written again for the masked packets.
  const packet = `42["auth",{"session":{"id":"${SECRET}"},"pin":24680}]`
  const eio3 = `2:40${packet.length}:${packet}`
  const out3 = maskBodyText(eio3, mime, counter())
  assert.ok(!out3.includes(SECRET) && !out3.includes('24680'), out3)
  const masked = out3.slice(out3.indexOf(':', 4) + 1)
  assert.equal(out3, `2:40${masked.length}:${masked}`)
  // Lengths that are off still get the JSON inside masked.
  const off = maskBodyText(`60:${packet}`, mime, counter())
  assert.ok(!off.includes(SECRET) && !off.includes('24680'), off)
  // `451-` binary events and namespaced packets.
  const binary = maskBodyText(`451-["upload",{"_placeholder":true,"num":0},{"apiKey":["${SECRET}"]}]`, mime, counter())
  assert.ok(!binary.includes(SECRET) && binary.startsWith('451-["upload"'), binary)
  const spaced = maskBodyText(`42/chat,7["auth",{"password":"${SECRET}"}]`, mime, counter())
  assert.equal(spaced, `42/chat,7["auth",{"password":"${MASK}"}]`)
})

test('review 4: keys inside a secret-named object are masked, field names stay', () => {
  const id = randomToken(4)
  const out = maskBodyText(`{"sessions":{"${id}":{"user":"alice","created":1700000000}},"ok":true}`, 'application/json', counter())
  assert.ok(!out.includes(id), out)
  assert.ok(out.includes('"ok":true'))
  const two = maskBodyText(`{"tokens":{"a3f9c2e1-7b44-4d0e-9a51-0c2d8e6f1b73":"read","b3f9c2e1-7b44-4d0e-9a51-0c2d8e6f1b74":"write"}}`, 'application/json', counter())
  assert.equal(two, `{"tokens":{"${MASK}":"${MASK}","${MASK}#2":"${MASK}"}}`, 'masked keys stay distinct')
  // Keys that are field names stay readable.
  assert.equal(maskBodyText('{"session":{"id":"x1","expiresAt":5}}', 'application/json', counter()), `{"session":{"id":"${MASK}","expiresAt":"${MASK}"}}`)
})

test('review 5: the sanitized copy is built in steps with progress, the same as at once', async () => {
  const files = new Map<string, Uint8Array>()
  const entries: HarEntry[] = []
  for (let i = 0; i < 150; i++) {
    const name = `body-${i}.txt`
    files.set(name, enc.encode(`password=${SECRET}-${i}&n=${i}`))
    entries.push(entry({ response: { status: 200, headers: [], content: { size: 30, mimeType: 'text/plain', _file: name } } }))
  }
  const sides: SideFiles = { has: (n) => files.has(n), get: (n) => files.get(n) ?? null, size: (n) => files.get(n)?.length ?? 0 }
  const recording = har(entries)
  const progress: number[] = []
  const steps = maskSteps(recording, sides)
  let next = steps.next()
  while (!next.done) {
    progress.push(next.value)
    next = steps.next()
  }
  assert.ok(progress.length > 2 && progress.every((p, i) => p >= 0 && p <= 1 && (i === 0 || p >= progress[i - 1])), 'progress only grows')
  const masked = next.value
  assert.equal(masked.report.entries.size, 150)
  // The zip comes out of the async runner whole, and opens with every masked file.
  const seen: number[] = []
  const zip = await runStepsAsync(maskedHarZipSteps(masked), (done) => seen.push(done), 0)
  assert.ok(seen.length > 0)
  const opened = openHarZip(zip)
  assert.equal(opened.names.length, 151)
  assert.ok(!dec.decode(opened.files.get('body-7.txt')!).includes(SECRET))
  assert.deepEqual(zip.length > 0, runSteps(maskedHarZipSteps(masked)).length > 0)
  assert.equal(maskedHarZip(masked).length > 0, true)
})

test('review 6: OAuth codes and secret parameters in hash-route URLs', () => {
  for (const url of [
    `https://app.example.com/#/auth/callback?code=${SECRET}&state=abc`,
    `https://app.example.com/#!/callback?state=abc&code=${SECRET}`,
    `https://app.example.com/#/download?sig=${SECRET}`,
    `https://app.example.com/#/verify?pin=${SECRET}`
  ]) {
    const out = maskUrl(url, counter())
    assert.ok(!out.includes(SECRET), out)
    assert.ok(out.startsWith(url.slice(0, url.indexOf('?') + 1)), 'the route stays')
  }
  assert.equal(maskUrl('https://app.example.com/#/docs/intro', counter()), 'https://app.example.com/#/docs/intro')
  assert.equal(maskUrl('https://app.example.com/#/r?state=abc', counter()), 'https://app.example.com/#/r?state=abc')
})

test('review 7: STOMP frames and unquoted `name: value` lines', () => {
  const connect = `CONNECT\naccept-version:1.2\nhost:broker.example.com\nlogin:guest\npasscode:${SECRET}\n\n\u0000`
  const out = maskBodyText(connect, '', counter())
  assert.equal(out, `CONNECT\naccept-version:1.2\nhost:broker.example.com\nlogin:guest\npasscode:${MASK}\n\n\u0000`)
  const send = `SEND\ndestination:/queue/a\ncontent-type:application/json\n\n{"token":"${SECRET}","n":1}\u0000`
  assert.equal(maskBodyText(send, '', counter()), `SEND\ndestination:/queue/a\ncontent-type:application/json\n\n{"token":"${MASK}","n":1}\u0000`)
  const yaml = `database:\n  host: db.example.com\n  password: ${SECRET}\napi_key = ${SECRET}\nspring.datasource.password=${SECRET}\nname: demo`
  const masked = maskText(yaml, counter())
  assert.ok(!masked.includes(SECRET), masked)
  assert.ok(masked.includes('host: db.example.com') && masked.includes('name: demo'))
})

test('review 8: JSON inside other text: SockJS, SSE, JSONP, XSSI, escaped HTML attributes, script blocks, log lines', () => {
  const cases: [string, string][] = [
    [`a["{\\"token\\":\\"${SECRET}\\"}"]`, ''],
    [`data: {"token":"${SECRET}"}\n\n`, 'text/event-stream'],
    [`jsonp_cb({"token":"${SECRET}"});`, 'application/javascript'],
    [`)]}'\n{"token":"${SECRET}"}`, 'application/json'],
    [`while(1);{"token":"${SECRET}"}`, 'text/plain'],
    [`<div id="app" data-page="{&quot;props&quot;:{&quot;token&quot;:&quot;${SECRET}&quot;}}"></div>`, 'text/html'],
    [`<script id="__NEXT_DATA__" type="application/json">{"props":{"token":"${SECRET}"}}</script>`, 'text/html'],
    [`INFO 2026-11-15 payload={"password":"${SECRET}","n":1} done`, 'text/plain'],
    [`<script>window.__STATE__ = {"sessions":{"${SECRET}":{"user":"a"}}};</script>`, 'text/html']
  ]
  for (const [text, mime] of cases) {
    const out = maskBodyText(text, mime, counter())
    assert.ok(!out.includes(SECRET), `${mime}: ${out}`)
  }
  // Context before an island still counts.
  assert.ok(!maskBodyText(`password: ["${SECRET}"]`, 'text/plain', counter()).includes(SECRET))
})

test('review 9: unquoted HTML attributes, minified forms and OAuth form_post', () => {
  const rails = `<form method=post action=/session><input type=hidden name=authenticity_token value=${SECRET}><meta name=csrf-token content=${SECRET}></form>`
  assert.equal(maskBodyText(rails, 'text/html', counter()), `<form method=post action=/session><input type=hidden name=authenticity_token value=${MASK}><meta name=csrf-token content=${MASK}></form>`)
  const post = `<form method=post action=https://app.example.com/cb><input type=hidden name=code value=${SECRET}><input type=hidden name=state value=st></form>`
  assert.ok(!maskBodyText(post, 'text/html', counter()).includes(SECRET))
  assert.ok(!maskBodyText(`<meta name=csrf-token content=${SECRET} />`, 'text/html', counter()).includes(SECRET))
})

test('review 10: double-encoded and deeply nested URLs keep no tokens', () => {
  const twice = `https://app.example.com/login?next=%252Freset%253Ftoken%253D${SECRET}`
  assert.equal(maskUrl(twice, counter()), `https://app.example.com/login?next=%252Freset%253Ftoken%253D${MASK}`)
  for (let levels = 1; levels <= 8; levels++) {
    let inner = `/reset?token=${SECRET}`
    for (let i = 1; i < levels; i++) inner = `/l${i}?next=${encodeURIComponent(inner)}`
    const out = maskUrl(`https://app.example.com${inner}`, counter())
    assert.ok(!out.includes(SECRET), `${levels} levels: ${out}`)
  }
})

test('review 11: fields of unexpected types, and log.creator/log.browser, are masked', () => {
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJkZW1vIn0', 'ZGVtby1zaWduYXR1cmU'].join('.')
  const odd = entry({
    request: {
      method: 'POST',
      url: 'https://api.example.com/v1/x',
      headers: { Authorization: `Bearer ${SECRET}` } as never,
      cookies: { sid: SECRET } as never,
      queryString: [{ name: 'token', value: [SECRET] as never }],
      postData: { mimeType: 'application/json', text: { password: SECRET } as never }
    },
    response: {
      status: 200,
      headers: [{ name: 'Set-Cookie', value: [`sid=${SECRET}`] as never }, { name: 'X-Count', value: 5 as never }],
      content: { size: 1, mimeType: 'application/json', text: { access_token: SECRET } as never }
    },
    _webSocketMessages: [{ type: 'send', time: 1, opcode: 1, data: { token: SECRET } as never }]
  })
  const recording = har([odd], {
    creator: { name: 'WebInspector', version: '537.36', comment: `token ${jwt}` } as never,
    browser: { name: 'Chrome', version: '131', comment: `password=${SECRET}` } as never
  })
  const { har: out, report } = sanitizeHar(recording)
  const text = JSON.stringify(out)
  assert.ok(!text.includes(SECRET) && !text.includes(jwt), text)
  assert.equal(report.failed.size, 0)
  assert.deepEqual([out.log.creator?.name, out.log.creator?.version, out.log.browser?.name], ['WebInspector', '537.36', 'Chrome'])
  // The model and the masked view still build.
  assert.equal(buildModel(out).entries.length, 1)
})

test('review 12: UTF-16 bodies under any label, and imperfect UTF-16, are masked losslessly', () => {
  const utf16 = (text: string, big = false, bom = false) => {
    const out = new Uint8Array((text.length + (bom ? 1 : 0)) * 2)
    const units = bom ? `﻿${text}` : text
    for (let i = 0; i < units.length; i++) {
      const code = units.charCodeAt(i)
      out[2 * i] = big ? code >> 8 : code & 0xff
      out[2 * i + 1] = big ? code & 0xff : code >> 8
    }
    return out
  }
  const body = `{"access_token":"${SECRET}","n":1}`
  const read = (bytes: Uint8Array, big: boolean) => {
    let text = ''
    for (let i = 0; i + 1 < bytes.length; i += 2) text += String.fromCharCode(big ? (bytes[i] << 8) | bytes[i + 1] : bytes[i] | (bytes[i + 1] << 8))
    return text
  }
  for (const [label, big, bom] of [
    ['utf-16', false, false],
    ['unicode', false, false],
    ['ucs-2', false, false],
    ['csunicode', false, false],
    ['utf-16be', true, false],
    ['unicodefffe', true, false],
    ['utf-8', true, true]
  ] as const) {
    const out = maskBodyBytes(utf16(body, big, bom), `application/json; charset=${label}`, counter())
    const text = read(out, big)
    assert.ok(!text.includes(SECRET) && text.includes(`"access_token":"${MASK}"`), `${label}: ${text}`)
  }
  // A lone surrogate and an odd last byte survive byte for byte around the masked value.
  const lone = utf16(`token=${SECRET}&x=\ud800`)
  const odd = new Uint8Array(lone.length + 1)
  odd.set(lone)
  odd[lone.length] = 0x41
  const out = maskBodyBytes(odd, 'text/plain; charset=utf-16le', counter())
  assert.equal(out[out.length - 1], 0x41)
  assert.deepEqual([...out.slice(out.length - 3, out.length - 1)], [0x00, 0xd8])
  assert.equal(read(out.slice(0, -1), false), `token=${MASK}&x=\ud800`)
})

test('review 13: a stored ZIP entry must be the size it declares, so the unpack budget holds', () => {
  const zip = zipSync({ 'har.har': enc.encode(JSON.stringify(har([entry({ response: { status: 200, content: { size: 8, mimeType: 'text/plain', _file: 'a.txt' } } })]))), 'a.txt': [enc.encode(`token=${SECRET}`), { level: 0 }] })
  // Set the central directory's size of a.txt to 0, as a crafted archive would.
  const bytes = zip.slice()
  const view = new DataView(bytes.buffer)
  for (let at = 0; at + 46 < bytes.length; at++) {
    if (view.getUint32(at, true) !== 0x02014b50) continue
    const nameLength = view.getUint16(at + 28, true)
    if (dec.decode(bytes.subarray(at + 46, at + 46 + nameLength)) === 'a.txt') view.setUint32(at + 24, 0, true)
  }
  const opened = openHarZip(bytes)
  assert.equal(opened.files.get('a.txt'), null)
  assert.equal(opened.files.problem?.('a.txt'), 'unreadable')
  const recording = JSON.parse(opened.text) as Har
  const body = responseBody(recording.log.entries![0], opened.files)
  assert.ok(body.kind === 'none' && body.reason === 'unreadable')
})

test('review 14: an entry that cannot be masked is masked whole and reported, never skipped', () => {
  const broken = entry({
    request: { method: 'POST', url: `https://api.example.com/v1/login?token=${SECRET}`, headers: [{ name: 'X-Api-Key', value: SECRET }], postData: { mimeType: 'text/plain', text: `pw ${SECRET}` } }
  })
  // A field that throws when masking reads it, as a bug in a masker would.
  let reads = 0
  const holder = broken.request!.postData as Record<string, unknown>
  const text = holder.text
  Object.defineProperty(holder, 'text', {
    enumerable: true,
    get() {
      if (reads++ === 0) throw new Error('masker failed')
      return text
    }
  })
  const { har: out, report } = sanitizeHar(har([entry(), broken]))
  assert.deepEqual([...report.failed], [1])
  assert.ok(report.entries.has(1))
  const saved = JSON.stringify(out.log.entries![1])
  assert.ok(!saved.includes(SECRET), saved)
  const blanked = out.log.entries![1]
  assert.equal(blanked.request?.method, 'POST')
  assert.equal(blanked.request?.url, `https://api.example.com/${MASK}`)
  assert.equal(blanked.request?.headers?.[0].name, 'X-Api-Key')
  assert.equal(blanked.response?.status, 200)
  assert.ok(String(blanked.comment).includes('could not mask'))
  // A body file that cannot be masked is replaced, and its request reported.
  const unreadable = new Uint8Array(3)
  Object.defineProperty(unreadable, 'length', {
    get() {
      throw new Error('cannot read')
    }
  })
  const files: SideFiles = { has: () => true, get: () => unreadable, size: () => 3 }
  const masked = maskRecording(har([entry({ response: { status: 200, content: { size: 3, mimeType: 'text/plain', _file: 'x.txt' } } })]), files)
  assert.deepEqual([...masked.report.failed], [0])
  assert.equal(dec.decode(masked.files!.get('x.txt')!), MASK)
})

test('review 15: odd field types do not break the pieces the details pane reads', () => {
  const odd = entry({ request: { method: 'GET', url: 'https://x.example.com/', headers: { Cookie: 'a=1' } as never }, response: { status: 200, headers: 'x' as never, cookies: 'y' as never } })
  assert.deepEqual(responseCookies(odd.response?.cookies, odd.response?.headers), [])
  assert.deepEqual(queryFields(odd, 'https://x.example.com/'), [])
  assert.equal(formFields(odd), null)
})

test('review 16: credential parameters outside the old name list', () => {
  const form = (url: string, text: string) =>
    JSON.stringify(sanitizeHar(har([entry({ request: { method: 'POST', url, postData: { mimeType: 'application/x-www-form-urlencoded', text } } })])).har)
  assert.ok(!form('https://login.example.com/oauth/token', `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${SECRET}`).includes(SECRET))
  assert.ok(!form('https://sts.example.com/adfs/ls/', `wa=wsignin1.0&wresult=${SECRET}`).includes(SECRET))
  assert.ok(!form('https://app.example.com/verify', `mfa_code=${SECRET}`).includes(SECRET))
  assert.ok(!maskUrl(`https://sso.example.com/cas/serviceValidate?ticket=${SECRET}&service=x`, counter()).includes(SECRET))
  const json = sanitizeHar(har([entry({ request: { method: 'POST', url: 'https://app.example.com/api/auth/callback', postData: { mimeType: 'application/json', text: `{"code":"${SECRET}","state":"s1"}` } } })]))
  assert.ok(!JSON.stringify(json.har).includes(SECRET))
  // Elsewhere `code` is an ordinary field.
  assert.equal(maskBodyText('{"code":"E1234","message":"not found"}', 'application/json', counter()), '{"code":"E1234","message":"not found"}')
})

test('review 17: nested multipart is bounded: thousands of levels mask in time, deep parts are replaced', () => {
  const nest = (levels: number) => {
    let body = `--b${levels}\r\nContent-Disposition: form-data; name="password"\r\n\r\n${SECRET}\r\n--b${levels}--\r\n`
    for (let i = levels - 1; i >= 0; i--) body = `--b${i}\r\nContent-Type: multipart/mixed; boundary=b${i + 1}\r\n\r\n${body}\r\n--b${i}--\r\n`
    return body
  }
  const text = nest(3500)
  let start = performance.now()
  const out = maskBodyText(text, 'multipart/mixed; boundary=b0', counter())
  assert.ok(performance.now() - start < 1000)
  assert.ok(!out.includes(SECRET))
  // The same as base64 bytes, the path that was quadratic.
  const recording = har([entry({ response: { status: 200, content: { size: text.length, mimeType: 'multipart/mixed; boundary=b0', text: encodeBase64(enc.encode(text)), encoding: 'base64' } } })])
  start = performance.now()
  const masked = maskRecording(recording)
  assert.ok(performance.now() - start < 1000)
  assert.equal(masked.report.failed.size, 0)
  // Real nesting (two levels) is masked part by part.
  const shallow = maskBodyText(nest(1), 'multipart/mixed; boundary=b0', counter())
  assert.ok(shallow.includes('name="password"') && shallow.includes(MASK) && !shallow.includes(SECRET))
})

test('review 18: ordinary data stays: otp inside words, every Link, JavaScript code', () => {
  const json = '{"rootPath":"/app","slotProps":{"input":{"id":"email"}},"pivotPoint":{"x":1,"y":2},"dotPlot":[1,2,3],"footprint":{"w":120}}'
  assert.equal(maskBodyText(json, 'application/json', counter()), json)
  assert.equal(maskBodyText(`{"otp":"${SECRET}","totpCode":"${SECRET}"}`, 'application/json', counter()), `{"otp":"${MASK}","totpCode":"${MASK}"}`)
  const link = `</assets/app.css?token=${SECRET}>; rel=preload; as=style, </x.js>; rel=preload`
  assert.equal(maskHeaderValue('Link', link, counter()), `</assets/app.css?token=${MASK}>; rel=preload; as=style, </x.js>; rel=preload`)
  const js = 'throw new Error("Unexpected token: " + token.type + " (" + pos + ")");'
  assert.equal(maskBodyText(js, 'application/javascript', counter()), js)
})

test('review 20, 21: body files too large or past the budget are named in the view and in the digest', () => {
  const recording = har([
    entry({ response: { status: 200, content: { size: 4, mimeType: 'text/plain', _file: 'big.txt' } } }),
    entry({ response: { status: 200, content: { size: 4, mimeType: 'text/plain', _file: 'b.txt' } } }),
    entry({ response: { status: 200, content: { size: 4, mimeType: 'text/plain', _file: 'c.txt' } } })
  ])
  const zip = zipSync({ 'har.har': enc.encode(JSON.stringify(recording)), 'big.txt': enc.encode('big!'), 'b.txt': enc.encode('x'.repeat(600)), 'c.txt': enc.encode('y'.repeat(600)) })
  // Declare big.txt as 300 MB, past the per-file limit.
  const bytes = zip.slice()
  const view = new DataView(bytes.buffer)
  for (let at = 0; at + 46 < bytes.length; at++) {
    if (view.getUint32(at, true) !== 0x02014b50) continue
    const nameLength = view.getUint16(at + 28, true)
    if (dec.decode(bytes.subarray(at + 46, at + 46 + nameLength)) === 'big.txt') view.setUint32(at + 24, 300 * 1024 * 1024, true)
  }
  const opened = openHarZip(bytes, { total: 1000, cache: 1 << 20 })
  const model = buildModel(JSON.parse(opened.text) as Har)
  assert.ok(responseBody(model.entries[0].raw, opened.files).kind === 'none')
  assert.equal(responseBody(model.entries[1].raw, opened.files).kind, 'text')
  const digest = buildDigest(model, model.entries, { title: '3 requests', bodies: true, files: opened.files })
  assert.ok(/big\.txt, which unpacks to more than 256 MB/.test(digest), digest)
  assert.ok(/c\.txt, not unpacked/.test(digest), digest)
  assert.equal(opened.files.problem?.('big.txt'), 'too-large')
  assert.equal(opened.files.problem?.('c.txt'), 'over-budget')
  assert.equal(requestBody(model.entries[0].raw, opened.files).kind, 'none')
})

test('review 23: the digest claims only known patterns, and counts one request right', () => {
  const recording = har([entry({ request: { method: 'POST', url: 'https://api.example.com/v1/pay', headers: [{ name: 'X-Client-Id', value: 'cli_live_8f2a91c7d3' }] } })])
  const model = buildModel(maskRecording(recording).har)
  const digest = buildDigest(model, model.entries, { title: '1 request', bodies: false })
  assert.ok(!/Secrets are masked/.test(digest))
  assert.ok(/Known secret patterns are masked/.test(digest) && /review before sharing/.test(digest))
  assert.ok(/1 request in the file/.test(digest), digest)
})

test('catch-all: random-looking values are masked anywhere; hashes, IDs and asset names stay', () => {
  const token = randomToken(11)
  assert.ok(isRandom(token))
  assert.equal(maskBodyText(`{"x":"${token}"}`, 'application/json', counter()), `{"x":"${MASK}"}`)
  assert.equal(maskBodyText(`{"${token}":1}`, 'application/json', counter()), `{"${MASK}":1}`)
  assert.equal(maskHeaderValue('X-Client-Key', token, counter()), MASK)
  assert.equal(maskUrl(`https://files.example.com/s/${token}/report.pdf`, counter()), `https://files.example.com/s/${MASK}/report.pdf`)
  assert.equal(maskText(`share link ${token} sent`, counter()), `share link ${MASK} sent`)
  // What people need to see stays.
  const keep = [
    () => maskHeaderValue('ETag', `"${token}"`, counter()) === `"${token}"`,
    () => maskHeaderValue('X-Request-Id', token, counter()) === token,
    () => maskHeaderValue('traceparent', `00-${'4bf92f3577b34da6a3ce929d0e0e4736'}-00f067aa0ba902b7-01`, counter()).includes('4bf92f3577b34da6'),
    () => maskBodyText(`{"id":"${token}","requestId":"${token}"}`, 'application/json', counter()) === `{"id":"${token}","requestId":"${token}"}`,
    () => maskUrl(`https://cdn.example.com/_next/static/chunks/${token}.js`, counter()).includes(token),
    () => maskUrl(`https://cdn.example.com/assets/main.${token}.css`, counter()).includes(token),
    () => maskText(`integrity="sha384-${token}${token}"`, counter()).includes(token),
    () => maskUrl('https://github.com/acme/app/commit/0123456789abcdef0123456789abcdef01234567', counter()).endsWith('01234567'),
    () => maskText('a3f9c2e1-7b44-4d0e-9a51-0c2d8e6f1b73', counter()) === 'a3f9c2e1-7b44-4d0e-9a51-0c2d8e6f1b73',
    () => maskBodyText(`body{background:url(data:image/png;base64,${token}${token})}`, 'text/css', counter()).includes(token)
  ]
  keep.forEach((check, i) => assert.ok(check(), `kept #${i}`))
  // Long identifiers and words are not random.
  for (const word of ['getElementsByClassName', 'ExampleServiceV2Client', 'abc_def_ghi_jkl_mno_1', 'application-json-2026', 'Content-Security-Policy']) {
    assert.ok(!isRandom(word), word)
  }
})

test('search keeps a bounded amount of body text, and still finds what it no longer keeps', () => {
  const entries = Array.from({ length: 4 }, (_, i) => entry({ response: { status: 200, content: { size: 1000, mimeType: 'text/plain', text: `${'x'.repeat(1000)} needle${i}` } } }))
  const model = buildModel(har(entries))
  const haystacks = new Haystacks(undefined, 2500)
  for (const e of model.entries) assert.ok(haystacks.get(e, 'all').join('\n').includes(`needle${e.index}`))
  // Read again past the cap: still found.
  assert.ok(haystacks.get(model.entries[3], 'all').join('\n').includes('needle3'))
})

test('review 22: a ZIP error shows the translated message only, no English detail under it', () => {
  const ru = stringsFor('ru', true)
  for (const code of ['not-zip', 'no-har', 'damaged', 'too-large', 'method'] as const) {
    const [message, detail] = openError(new ZipError(code, 'This ZIP holds no .har file.'), ru)
    assert.equal(detail, undefined, code)
    assert.ok(/[а-яё]/i.test(message) && !/ZIP holds/.test(message), `${code}: ${message}`)
  }
  // Other errors still show what went wrong.
  assert.deepEqual(openError(new Error('boom'), ru), [ru.errorZipDamaged, 'boom'])
})
