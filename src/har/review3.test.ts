// Regression tests for the findings of the 0.1.0 round-3 review (numbers in the test names).
// Every fixture is built here from obviously fake values.

import { assert, test } from 'orca/testing'
import { demoHar } from '../fixtures/demo'
import { tokenize } from '../highlight'
import type { SideFiles } from './body'
import { copyable, safeUrl, toCurl, toFetch } from './copy'
import { buildDigest } from './digest'
import { formFields } from './fields'
import { isFieldName } from './mask-body'
import { safeDecode } from './mask-text'
import { maskedHarBytes, maskRecording } from './masked'
import { buildModel } from './model'
import { readError } from '../open-errors'
import { fill, stringsFor } from '../i18n'
import { isCompact, jsonError, MAX_TRACKED_DEPTH, readHar } from './read'
import { MASK, maskBodyText, maskHeaderValue, maskUrl, sanitizeHar, type Counter } from './sanitize'
import type { Har, HarEntry, HarNameValue } from './types'

const NUL = String.fromCharCode(0)

function counter(): Counter & { n: number } {
  const c = {
    n: 0,
    add(_kind: string, count = 1) {
      c.n += count
    }
  }
  return c
}

function har(...entries: HarEntry[]): Har {
  return { log: { version: '1.2', creator: { name: 'test', version: '1' }, entries } }
}

/** Everything a masked recording shows: the file, the digest, cURL and fetch. */
function outputs(input: Har): string {
  const masked = sanitizeHar(input).har
  const model = buildModel(masked)
  const entry = masked.log.entries![0]
  return [JSON.stringify(masked), buildDigest(model, model.entries, { title: 't', bodies: true }), toCurl(entry), toFetch(entry)].join('\n')
}

function request(over: Partial<NonNullable<HarEntry['request']>> = {}): HarEntry {
  return { request: { method: 'GET', url: 'http://127.0.0.1:18777/collect', headers: [], ...over } }
}

/** A command's lines: `curl --url …`, then one option and its quoted parameter per line. */
const lines = (command: string) => command.split(' \\\n  ')
const QUOTED = String.raw`(?:'(?:[^']|'\\'')*'|\$'(?:[^'\\]|\\.)*')`
const LINE = new RegExp(String.raw`^(?:(?:curl --url|-X|-H|-b|--data-raw|--data-binary) ${QUOTED}|--compressed)$`)

test('review 1: Copy as cURL drops header names that are not tokens, so no -H @file reaches curl', () => {
  const headers: HarNameValue[] = [
    { name: '@notes.txt', value: '1' },
    { name: '@local.cfg X-Other', value: '1' },
    { name: ':authority', value: 'e.test' },
    { name: 'x-ok', value: '2' }
  ]
  const curl = toCurl(request({ headers }))!
  assert.ok(!curl.includes('@'), curl)
  assert.ok(!curl.includes('authority'), curl)
  assert.ok(curl.includes(`-H 'x-ok: 2'`), curl)
  const fetch = toFetch(request({ headers }))!
  assert.ok(!fetch.includes('@') && !fetch.includes('authority') && fetch.includes('"x-ok": "2"'), fetch)
})

test('review 1: NUL, CR or LF in a header, a control character in the URL or a method that is not a token refuse the copy', () => {
  const refused: HarEntry[] = [
    // The verifier's shape: bash and zsh cut $'@notes.txt<NUL>X-Trace' at the NUL.
    request({ headers: [{ name: `@notes.txt${NUL}X-Trace`, value: '1' }] }),
    request({ headers: [{ name: 'x-trace', value: `1${NUL}2` }] }),
    request({ headers: [{ name: 'x-trace', value: 'a\r\nx-other: b' }] }),
    request({ headers: [{ name: 'x-trace\n', value: '1' }] }),
    request({ headers: [{ name: 'cookie', value: `a=1${NUL}` }] }),
    request({ url: `http://e.test/a${NUL}b` }),
    request({ url: 'http://e.test/a\nrm -rf ~' }),
    request({ url: 'http://e.test/\tb' }),
    request({ method: 'GET -o /tmp/x' }),
    request({ method: 'GET\n' })
  ]
  for (const entry of refused) {
    assert.equal(copyable(entry), false, JSON.stringify(entry))
    assert.equal(toCurl(entry), null)
    assert.equal(toFetch(entry), null)
  }
  // Copy URL refuses the same URLs; ordinary ones pass.
  assert.equal(safeUrl('http://e.test/a\nb'), false)
  assert.equal(safeUrl(`http://e.test/${NUL}`), false)
  assert.equal(safeUrl('https://api.example.com/v1/items?q=a%0Ab#x'), true)
  // An empty method is GET, as before.
  assert.ok(toCurl(request({ method: '' })))
})

test('review 1: the URL goes in as --url, a cookie without "=" as a header, and every value as an option parameter', () => {
  // curl would read a bare '-K…' as an option; as the parameter of --url it is a URL.
  assert.equal(lines(toCurl(request({ url: '-Kcurl.cfg' }))!)[0], `curl --url '-Kcurl.cfg'`)
  // curl reads a -b value without '=' as a cookie file.
  const file = toCurl(request({ headers: [{ name: 'Cookie', value: 'cookies.txt' }] }))!
  assert.ok(file.includes(`-H 'Cookie: cookies.txt'`) && !file.includes('-b '), file)
  assert.ok(toCurl(request({ headers: [{ name: 'Cookie', value: 'a=1; b=2' }] }))!.includes(`-b 'a=1; b=2'`))
  // A token name may start with '-'; it stays the parameter of -H.
  assert.ok(toCurl(request({ headers: [{ name: '-v', value: 'x' }] }))!.includes(`-H '-v: x'`))
  // Every line of every demo request is an option with one quoted parameter.
  for (const entry of demoHar().log.entries!) {
    const curl = toCurl(entry)
    assert.ok(curl, entry.request?.url)
    for (const line of lines(curl!)) assert.ok(LINE.test(line), line)
  }
})

test('review 1: a body a shell cannot carry is left out, with a placeholder that names no path', () => {
  // A shell cuts an argument at NUL, so this text body is not passed.
  const nul = toCurl(request({ method: 'POST', postData: { mimeType: 'text/plain; charset=utf-8', text: `a${NUL}b` } }))!
  assert.ok(nul.endsWith(`--data-binary '@<3 bytes of text/plain, not included>'`), nul)
  // The type of a binary body comes from the file: no '..', spaces, quotes or ';' get into the placeholder.
  const bytes = toCurl(request({ method: 'POST', postData: { mimeType: "image/../../notes.txt' x;y", encoding: 'base64', text: 'AAEC' } }))!
  const placeholder = lines(bytes).at(-1)!
  assert.ok(placeholder.startsWith(`--data-binary '@<3 bytes of image/`), placeholder)
  assert.ok(!placeholder.includes('..') && !placeholder.includes(' x') && !placeholder.includes(';'), placeholder)
  // fetch keeps the text, escaped by JSON.
  assert.ok(toFetch(request({ method: 'POST', postData: { mimeType: 'text/plain', text: `a${NUL}b` } }))!.includes('a\\u0000b'))
})

test('review 2: JSON in a query value or a form field is masked by key name', () => {
  const variables = JSON.stringify({ email: 'ann@example.com', inviteCode: 'WELCOME-ANN-2026', pin: '48213', password: 'Hunter2-Secret!pw' })
  const url = `https://api.example.com/graphql?operationName=AcceptInvite&variables=${encodeURIComponent(variables)}`
  // A GraphQL GET as Chrome records it (raw values) and as Playwright does (decoded values).
  for (const value of [encodeURIComponent(variables), variables]) {
    const queryString = [{ name: 'operationName', value: 'AcceptInvite' }, { name: 'variables', value }]
    const text = outputs(har({ request: { method: 'GET', url, headers: [], queryString }, response: { status: 200 } }))
    for (const secret of ['Hunter2-Secret', '48213']) assert.ok(!text.includes(secret), `${secret} in ${value.slice(0, 20)}`)
    // Names that are not secret stay readable.
    assert.ok(text.includes('WELCOME-ANN-2026') && text.includes('AcceptInvite'))
  }
  // An urlencoded field holding JSON.
  const c = counter()
  const form = maskBodyText('event=signup&props=%7B%22password%22%3A%22hunter2%22%7D', 'application/x-www-form-urlencoded', c)
  assert.equal(safeDecode(form), `event=signup&props={"password":"${MASK}"}`)
  assert.equal(c.n, 1)
  // Raw JSON in a query, and an encoded JSON array.
  assert.ok(safeDecode(maskUrl('https://api.example.com/api?filter={"secret":"hunter2"}', counter())).includes(`{"secret":"${MASK}"}`))
  const array = maskUrl(`https://api.example.com/api?q=${encodeURIComponent('[{"password":"hunter2"}]')}`, counter())
  assert.ok(!safeDecode(array).includes('hunter2'), array)
  // JSON with nothing secret, and values that only look like JSON, stay as they were.
  const plain = 'https://api.example.com/api?filter=%7B%22status%22%3A%22open%22%2C%22limit%22%3A20%7D&tag=[masked]&x=[1,2'
  const none = counter()
  assert.equal(maskUrl(plain, none), plain)
  assert.equal(none.n, 0)
})

test('review 4: damaged-file reading tracks at most 512 levels of nesting', () => {
  // The error finder stops at the first bracket past the limit.
  const deep = `{"log":{"entries":${'['.repeat(100_000)}`
  assert.equal(jsonError(deep)?.offset, '{"log":{"entries":'.length + MAX_TRACKED_DEPTH - 2)
  assert.equal(jsonError(deep)?.eof, false)
  // The walk still pairs brackets past the limit: both entries around a field 1,000 levels deep are read.
  const entry = (n: number, extra = '') => `{"request":{"method":"GET","url":"https://e.test/${n}"},"response":{"status":200}${extra}}`
  const cut = `{"log":{"version":"1.2","entries":[${entry(1, `,"x":${'['.repeat(1000)}${']'.repeat(1000)}`)},${entry(2)},{"request":{"meth`
  const read = readHar(cut)
  assert.ok(read.ok)
  if (read.ok) assert.deepEqual(read.har.log.entries!.map((e) => e.request?.url), ['https://e.test/1', 'https://e.test/2'])
  // A file of nothing but brackets reads as broken, without a frame per bracket.
  const brackets = readHar(`{"log":{"entries":${'['.repeat(2_000_000)}`)
  assert.ok(!brackets.ok || brackets.har.log.entries!.length === 0)
})

test('review 5: HTML highlighting finds closing script and style tags in linear time, at the right offset', () => {
  // Lowercasing the whole body once per tag took about a second for 400,000 characters of tags.
  for (const unit of ['<script></script>', '<STYLE></STYLE>', '<script></script>Ж']) {
    const text = unit.repeat(Math.floor(400_000 / unit.length))
    const start = performance.now()
    tokenize(text, 'html')
    assert.ok(performance.now() - start < 400, unit)
  }
  // 'İ' lowercases to two characters, which shifted the old offset into the script body.
  const tokens = tokenize('İİİİİ<script>var a = 1</SCRIPT><b>bold</b>', 'html')
  assert.deepEqual(tokens.slice(-4), [['number', '1'], ['tag', '</SCRIPT><b>'], ['plain', 'bold'], ['tag', '</b>']])
})

test('review 6: an ID the JSON keeps under an id name stays in REST paths, before or after that body', () => {
  const order = 'ord_8f2a91c7d3e4b5a6c7d8'
  const ulid = '01HF8Z3Q7K2M9N4P6R8T0V2X4Y'
  const reset = 'Zk3qP9vX2mL7tR4wB8nC5yH1'
  const get = (path: string, status = 200): HarEntry => ({ request: { method: 'GET', url: `https://api.example.com${path}`, headers: [] }, response: { status } })
  const created: HarEntry = {
    request: { method: 'POST', url: 'https://api.example.com/v1/orders', headers: [] },
    response: { status: 201, content: { mimeType: 'application/json', text: JSON.stringify({ id: order, user: { userId: ulid } }) } }
  }
  // The failing detail request comes before the body that names the order, and one after it.
  const input = har(get(`/v1/orders/${order}`, 500), created, get(`/v1/users/${ulid}/orders`), get(`/v1/reset/${reset}`), get(`/v1/x?token=${order}`))
  const { har: out, report } = sanitizeHar(input)
  const urls = out.log.entries!.map((e) => e.request?.url)
  assert.equal(urls[0], `https://api.example.com/v1/orders/${order}`)
  assert.equal(urls[2], `https://api.example.com/v1/users/${ulid}/orders`)
  // A random segment no JSON names is still masked, and a secret name still decides.
  assert.equal(urls[3], `https://api.example.com/v1/reset/${MASK}`)
  assert.equal(urls[4], `https://api.example.com/v1/x?token=${MASK}`)
  assert.ok(report.total >= 2)
  // The always-masked digest names the order that failed.
  const model = buildModel(out)
  assert.ok(buildDigest(model, [model.entries[0]], { title: 't', bodies: false }).includes(`/v1/orders/${order}`))
  // A .har.zip: the JSON is in a body file, masked before the URLs.
  const zipped: HarEntry = { ...created, response: { status: 201, content: { mimeType: 'application/json', size: 60, _file: 'created.json' } } }
  const body = new TextEncoder().encode(JSON.stringify({ id: order }))
  const files: SideFiles = { has: (name) => name === 'created.json', get: () => body, size: () => body.length }
  const masked = maskRecording(har(get(`/v1/orders/${order}`, 500), zipped), files)
  assert.equal(masked.har.log.entries![0].request?.url, `https://api.example.com/v1/orders/${order}`)
})

test('review 7, 8, 9: CORS, identifier and Content-Type headers keep their values; credentials do not', () => {
  const kept = counter()
  const headers: [string, string][] = [
    ['Access-Control-Allow-Credentials', 'true'],
    ['Access-Control-Allow-Headers', 'Authorization, X-Api-Key'],
    ['X-Build', '2026.11.15-9f3c2a1b7d8e4f60a5b2'],
    ['X-App-Version', '4.12.0+build.7f3a9c21b4e8d0f6a2c5'],
    ['X-Commit', 'e83c5163316f89bfbde7d9ab23ca2e25604af290'],
    ['X-Git-Sha', 'e83c5163316f89bfbde7d9ab23ca2e25604af290'],
    ['X-Revision', '9f86d081884c7d659a2feaa0c55ad015'],
    ['X-Deployment-Id', 'dpl_8kQz3Xv7Lm2Np9Rt4Yw6Bc1D'],
    ['x-amz-version-id', '3HL4kqtJlcpXroDTDmJ7rmSpXd3dIbrHY'],
    ['x-amz-apigw-id', 'Bn7aKFm5IAMEVqA9xT2p']
  ]
  // Chrome and WebKit, Firefox and curl boundaries: the header must keep matching the body.
  for (const boundary of ['----WebKitFormBoundary7MA4YWxkTrZu0gW', '----geckoformboundaryd63a10cb2f335b1efc2092e192afde7b', '------------------------d74496d66958873e']) {
    headers.push(['Content-Type', `multipart/form-data; boundary=${boundary}`])
  }
  for (const [name, value] of headers) assert.equal(maskHeaderValue(name, value, kept), value, name)
  assert.equal(kept.n, 0)
  // Still masked: credentials by name, and random values under other names.
  assert.equal(maskHeaderValue('X-Api-Key', 'abc123def456', counter()), MASK)
  assert.equal(maskHeaderValue('X-Upstream-Credential', 'opaque-value-1', counter()), MASK)
  assert.equal(maskHeaderValue('X-Custom', 'Zk3qP9vX2mL7tR4wB8nC5yH1', counter()), MASK)
  // A masked upload copies as a request whose header and body still agree.
  const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW'
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nHoliday\r\n--${boundary}--\r\n`
  const upload: HarEntry = {
    request: { method: 'POST', url: 'https://api.example.com/upload', headers: [{ name: 'Content-Type', value: `multipart/form-data; boundary=${boundary}` }], postData: { mimeType: `multipart/form-data; boundary=${boundary}`, text: body } },
    response: { status: 200 }
  }
  const curl = toCurl(sanitizeHar(har(upload)).har.log.entries![0])!
  assert.ok(curl.includes(`-H 'Content-Type: multipart/form-data; boundary=${boundary}'`), curl)
  assert.ok(curl.includes(`--${boundary}--`), curl)
})

test('review 10: under a secret-named object, ID keys made only of letters are masked; field names stay', () => {
  for (const id of ['kjhsdfkjhsdfkjhsdfkjhsdf', 'AbCdEfGhIjKlMnOpQrStUvWx', 'qWeRtYuIoPaSdFgHjKlZxCvB', 'xQz-vRpLmN_KjHgFdSaWeYuI', 'ABCDEFGHIJKLMNOPQRSTUVWX', 'kjhsdfkjhsdf']) {
    const out = maskBodyText(JSON.stringify({ sessions: { [id]: { user: 'alice' } } }), 'application/json', counter())
    assert.ok(!out.includes(id), out)
    assert.ok(out.includes(`"${MASK}":{"user":"${MASK}"}`), out)
  }
  for (const name of ['user', 'createdAt', 'expires_in', 'lastLoginIpAddressV2', 'line2', '@type', '$ref', 'IPv4', 'deviceName', 'ttl', 'https', 'refresh_token_expires_at']) {
    assert.ok(isFieldName(name), name)
  }
  const kept = maskBodyText('{"session":{"createdAt":"2026-11-15","deviceName":"laptop"}}', 'application/json', counter())
  assert.equal(kept, `{"session":{"createdAt":"${MASK}","deviceName":"${MASK}"}}`)
})

test('review 11: a minified recording gets a minified copy, and an indented one past the limit is minified', () => {
  const source = demoHar()
  const minified = readHar(JSON.stringify(source))
  const indented = readHar(`\uFEFF${JSON.stringify(source, null, 2)}\n`)
  assert.ok(minified.ok && minified.compact === true)
  assert.ok(indented.ok && indented.compact === undefined)
  assert.ok(isCompact('{"log":{"entries":[]}}\n'))
  const masked = maskRecording(source)
  const dec = new TextDecoder()
  const small = dec.decode(maskedHarBytes(masked, true, 64 << 20))
  assert.ok(!small.includes('\n'))
  const pretty = dec.decode(maskedHarBytes(masked, false, 64 << 20))
  assert.ok(pretty.startsWith('{\n  "log"'))
  // Over the limit indented, it falls back to one line: still the same masked recording.
  const fallback = dec.decode(maskedHarBytes(masked, false, pretty.length - 1))
  assert.equal(fallback, small)
  assert.deepEqual(JSON.parse(fallback), JSON.parse(pretty))
})

test('review 12: a form posted in Playwright attach mode lists its fields from the body file', () => {
  const body = new TextEncoder().encode('grant_type=password&q=hello+world&sig=ab%2Bcd%3D%3D&name=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82')
  const files: SideFiles = { has: (name) => name === 'form.dat', get: (name) => (name === 'form.dat' ? body : null), size: () => body.length }
  const post = (mimeType: string, file = 'form.dat'): HarEntry => ({
    request: { method: 'POST', url: 'https://api.example.com/oauth/token', headers: [], postData: { mimeType, text: '', params: [], _file: file } },
    response: { status: 200 }
  })
  const expected = [['grant_type', 'password'], ['q', 'hello world'], ['sig', 'ab+cd=='], ['name', 'Привет']]
  assert.deepEqual(formFields(post('application/x-www-form-urlencoded;charset=UTF-8'), files), expected)
  // Without the files (a plain .har pointing elsewhere), a file that is missing, or another type: no form.
  assert.equal(formFields(post('application/x-www-form-urlencoded;charset=UTF-8')), null)
  assert.equal(formFields(post('application/x-www-form-urlencoded', 'gone.dat'), files), null)
  assert.equal(formFields(post('application/json'), files), null)
  // Params a recorder wrote still count when there is no text and no file.
  const params: HarEntry = { request: { method: 'POST', url: 'https://api.example.com/f', headers: [], postData: { mimeType: 'multipart/form-data', params: [{ name: 'a', value: '1' }] } } }
  assert.deepEqual(formFields(params, files), [['a', '1']])
})

test('review 15: the Russian UI shows where the JSON breaks, without the browser\'s English message', () => {
  const ru = stringsFor('ru', true)
  const en = stringsFor('en', true)
  const broken = readHar('This is not JSON at all')
  assert.ok(!broken.ok)
  const [message, detail] = readError(broken, ru)
  assert.equal(message, ru.errorNotJson)
  assert.equal(detail, 'Строка 1, столбец 1')
  // English keeps the engine's hint.
  assert.ok(readError(broken, en)[1]?.startsWith('Line 1, column 1: '))
  const values = { line: 2959, column: 32, message: "Expected ',' or '}' after property value", count: '17 запросов' }
  const notice = fill(ru.invalid, values)
  assert.equal(notice, 'JSON повреждён на строке 2959, столбце 32. Показаны 17 запросов, которые удалось прочитать.')
  assert.ok(!/[A-Za-z]{3}/.test(notice.replace('JSON', '')), notice)
})
