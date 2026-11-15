import { assert, test } from 'orca/testing'
import { decodeBase64, encodeBase64 } from './body'
import {
  MASK,
  isSensitiveName,
  maskBodyText,
  maskCookieHeader,
  maskHeaderValue,
  maskSetCookie,
  maskText,
  maskUrl,
  sanitizeHar,
  sanitizeSideFile,
  type Counter
} from './sanitize'
import type { Har, HarEntry } from './types'

// Obviously fake values in the shapes the sanitizer must catch.
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vLXVzZXIiLCJpYXQiOjE3MDAwMDAwMDB9.c2lnbmF0dXJlLWRlbW8tb25seQ'
const OPENAI = 'sk-proj-DEMOdemoDEMOdemo1234567890abcdef'
const ANTHROPIC = 'sk-ant-api03-DEMOdemoDEMOdemoDEMO-demo'
const GITHUB = 'ghp_DEMOdemoDEMOdemoDEMOdemoDEMOdemo1234'
const AWS = 'AKIAIOSFODNN7EXAMPLE'
const GOOGLE = 'AIzaSyDEMOdemoDEMOdemoDEMOdemoDEMOdemo1'
const SLACK = 'xoxb-1234567890-DEMOdemoDEMO'
const STRIPE = 'sk_live_DEMOdemoDEMOdemo1234'

function counter(): Counter & { n: number; kinds: string[] } {
  const c = {
    n: 0,
    kinds: [] as string[],
    add(kind: string, count = 1) {
      c.n += count
      c.kinds.push(kind)
    }
  }
  return c
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

function har(...entries: HarEntry[]): Har {
  return { log: { version: '1.2', creator: { name: 'test', version: '1' }, pages: [], entries } }
}

test('names: secrets by name, ordinary names left alone', () => {
  for (const name of [
    'Authorization',
    'Proxy-Authorization',
    'Cookie',
    'X-API-Key',
    'x-goog-api-key',
    'apiKey',
    'api_key',
    'key',
    'access_token',
    'refresh_token',
    'id_token',
    'client_secret',
    'password',
    'passwd',
    'X-CSRF-Token',
    'X-XSRF-TOKEN',
    'x-amz-security-token',
    'X-Amz-Signature',
    'X-Amz-Credential',
    'sig',
    'JSESSIONID',
    'PHPSESSID',
    'session_id',
    'Ocp-Apim-Subscription-Key',
    'x-functions-key',
    'stripe-signature',
    'x-hub-signature-256',
    'authenticity_token'
  ]) {
    assert.ok(isSensitiveName(name), name)
  }
  for (const name of [
    'Content-Type',
    'Accept',
    'User-Agent',
    'Sec-WebSocket-Key',
    'X-Request-Id',
    'WWW-Authenticate',
    'x-goog-authuser',
    'client_id',
    'page',
    'q',
    'author',
    'Keep-Alive',
    'monkey',
    'Public-Key-Pins',
    'token_type'
  ]) {
    assert.ok(!isSensitiveName(name), name)
  }
})

test('free text: token shapes are masked wherever they are', () => {
  for (const secret of [JWT, OPENAI, ANTHROPIC, GITHUB, AWS, GOOGLE, SLACK, STRIPE]) {
    const c = counter()
    const out = maskText(`before ${secret} after`, c)
    assert.equal(out, `before ${MASK} after`, secret)
    assert.equal(c.n, 1)
  }
  const key = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----'
  assert.equal(maskText(`x ${key} y`, counter()), `x ${MASK} y`)
  assert.equal(maskText('-----BEGIN RSA PRIVATE KEY-----\nMIIEow cut off', counter()), MASK)
})

test('free text: schemes, URL passwords, quoted pairs and HTML tokens', () => {
  assert.equal(maskText('Authorization: Bearer abcDEF123456789', counter()), `Authorization: Bearer ${MASK}`)
  assert.equal(maskText('use Basic dXNlcjpwYXNzd29yZA==', counter()), `use Basic ${MASK}`)
  assert.equal(maskText('Token authentication is used here', counter()), 'Token authentication is used here')
  assert.equal(maskText('postgres://admin:hunter2@db.example.com/app', counter()), `postgres://admin:${MASK}@db.example.com/app`)
  assert.equal(maskText('const cfg = { password: "hunter2", user: "demo" }', counter()), `const cfg = { password: "${MASK}", user: "demo" }`)
  assert.equal(maskText(`window.apiKey = 'abc123def'`, counter()), `window.apiKey = '${MASK}'`)
  assert.equal(
    maskText('<meta name="csrf-token" content="q1w2e3r4t5">', counter()),
    `<meta name="csrf-token" content="${MASK}">`
  )
  assert.equal(
    maskText('<input type="hidden" name="authenticity_token" value="zz99">', counter()),
    `<input type="hidden" name="authenticity_token" value="${MASK}">`
  )
  assert.equal(maskText('<input type="password" name="user" value="demo">', counter()), '<input type="password" name="user" value="demo">')
  assert.equal(maskText('see https://x.example.com/cb?token=abc&page=2', counter()), `see https://x.example.com/cb?token=${MASK}&page=2`)
})

test('free text: ordinary text is left exactly as it is', () => {
  const samples = [
    'Hello, world',
    '{"items":[1,2,3],"next":"/v1/items?page=2"}',
    'function f(a){return a.key===b.key}',
    'body { color: red; }',
    'The password field must not be empty.',
    'https://cdn.example.net/app.3f9a2c.js?v=12'
  ]
  for (const sample of samples) {
    const c = counter()
    assert.equal(maskText(sample, c), sample)
    assert.equal(c.n, 0, sample)
  }
})

test('URLs: secret query and fragment parameters, OAuth codes', () => {
  const c = counter()
  assert.equal(
    maskUrl('https://api.example.com/v1/items?api_key=abc123&page=2&access_token=tok#frag', c),
    `https://api.example.com/v1/items?api_key=${MASK}&page=2&access_token=${MASK}#frag`
  )
  assert.equal(c.n, 2)
  assert.equal(
    maskUrl('https://app.example.com/oauth/callback?code=4/0AbCd&state=xyz', counter()),
    `https://app.example.com/oauth/callback?code=${MASK}&state=xyz`
  )
  assert.equal(maskUrl('https://shop.example.com/products?code=US&sort=asc', counter()), 'https://shop.example.com/products?code=US&sort=asc')
  assert.equal(
    maskUrl('https://app.example.com/#access_token=abc&token_type=bearer', counter()),
    `https://app.example.com/#access_token=${MASK}&token_type=bearer`
  )
  assert.equal(maskUrl(`https://maps.example.com/api?key=${GOOGLE}`, counter()), `https://maps.example.com/api?key=${MASK}`)
  assert.equal(maskUrl(`https://h.example.com/v/${JWT}/x`, counter()), `https://h.example.com/v/${MASK}/x`)
  assert.equal(maskUrl('https://user:pa55@h.example.com/', counter()), `https://user:${MASK}@h.example.com/`)
  assert.equal(maskUrl('/relative/path?X-Amz-Signature=abcdef&X-Amz-Date=2026', counter()), `/relative/path?X-Amz-Signature=${MASK}&X-Amz-Date=2026`)
  assert.equal(maskUrl('https://plain.example.com/a?b=c', counter()), 'https://plain.example.com/a?b=c')
})

test('headers: credentials, cookies and secret names; schemes kept', () => {
  assert.equal(maskHeaderValue('Authorization', `Bearer ${JWT}`, counter()), `Bearer ${MASK}`)
  assert.equal(maskHeaderValue('authorization', 'Basic dXNlcjpwYXNz', counter()), `Basic ${MASK}`)
  assert.equal(maskHeaderValue('Authorization', 'rawtokenvalue', counter()), MASK)
  assert.equal(maskHeaderValue('X-API-Key', OPENAI, counter()), MASK)
  assert.equal(maskHeaderValue('x-custom', `prefix ${OPENAI}`, counter()), `prefix ${MASK}`)
  assert.equal(maskHeaderValue('Referer', 'https://app.example.com/?session=s1', counter()), `https://app.example.com/?session=${MASK}`)
  assert.equal(maskHeaderValue('Content-Type', 'application/json', counter()), 'application/json')
  assert.equal(maskCookieHeader('sid=abc; theme=dark; empty=', counter()), `sid=${MASK}; theme=${MASK}; empty=`)
  assert.equal(maskSetCookie('sid=abc123; Path=/; HttpOnly; Secure', counter()), `sid=${MASK}; Path=/; HttpOnly; Secure`)
  assert.equal(
    maskHeaderValue('set-cookie', 'a=1; Path=/\nb=2; HttpOnly', counter()),
    `a=${MASK}; Path=/\nb=${MASK}; HttpOnly`
  )
})

test('bodies: JSON by key (nested and whole subtrees), forms by field, NDJSON by line', () => {
  const json = JSON.stringify({
    user: { email: 'demo@example.com', password: 'hunter2' },
    credentials: { username: 'demo', pin: 1234, ok: true },
    items: [{ id: 1, apiKey: 'abc' }],
    note: `token is ${JWT}`
  })
  const c = counter()
  const out = JSON.parse(maskBodyText(json, 'application/json', c))
  assert.equal(out.user.email, 'demo@example.com')
  assert.equal(out.user.password, MASK)
  assert.deepEqual(out.credentials, { username: MASK, pin: MASK, ok: true })
  assert.equal(out.items[0].apiKey, MASK)
  assert.equal(out.items[0].id, 1)
  assert.equal(out.note, `token is ${MASK}`)
  assert.equal(c.n, 5)

  const pretty = JSON.stringify({ token: 'x1', a: 1 }, null, 2)
  assert.equal(maskBodyText(pretty, 'application/json', counter()), JSON.stringify({ token: MASK, a: 1 }, null, 2))
  const untouched = '{"a": 1,   "b": [1, 2]}'
  assert.equal(maskBodyText(untouched, 'application/json', counter()), untouched)

  assert.equal(
    maskBodyText('username=demo&password=hunter2&remember=1', 'application/x-www-form-urlencoded', counter()),
    `username=demo&password=${MASK}&remember=1`
  )
  assert.equal(
    maskBodyText('{"a":1,"token":"t"}\n{"b":2}', 'application/x-ndjson', counter()),
    `{"a":1,"token":"${MASK}"}\n{"b":2}`
  )
  // Broken JSON still has its quoted pairs masked.
  assert.equal(maskBodyText('{"password": "hunter2", "a": [', 'application/json', counter()), `{"password": "${MASK}", "a": [`)
})

test('a whole HAR: every place a secret hides, and the input stays untouched', () => {
  const input = har(
    entry({
      pageref: 'page_1',
      request: {
        method: 'POST',
        url: `https://api.example.com/v1/login?api_key=k123&lang=en`,
        httpVersion: 'h2',
        headers: [
          { name: ':path', value: '/v1/login?api_key=k123&lang=en' },
          { name: 'Authorization', value: `Bearer ${JWT}` },
          { name: 'Cookie', value: 'sid=s1; theme=dark' },
          { name: 'X-API-Key', value: OPENAI },
          { name: 'Accept', value: 'application/json' }
        ],
        cookies: [{ name: 'sid', value: 's1' }],
        queryString: [
          { name: 'api_key', value: 'k123' },
          { name: 'lang', value: 'en' }
        ],
        postData: { mimeType: 'application/json', text: '{"user":"demo","password":"hunter2"}' }
      },
      response: {
        status: 200,
        statusText: 'OK',
        headers: [
          { name: 'Set-Cookie', value: 'sid=s2; Path=/; HttpOnly' },
          { name: 'Content-Type', value: 'application/json' }
        ],
        cookies: [{ name: 'sid', value: 's2', httpOnly: true }],
        content: {
          size: 40,
          mimeType: 'application/json',
          encoding: 'base64',
          text: encodeBase64(new TextEncoder().encode(JSON.stringify({ access_token: GITHUB, expires_in: 3600 })))
        },
        redirectURL: ''
      },
      _initiator: { type: 'script', stack: { callFrames: [{ functionName: 'login', url: 'https://app.example.com/app.js?token=abc', lineNumber: 1, columnNumber: 2 }] } },
      _webSocketMessages: [
        { type: 'send', time: 1, opcode: 1, data: '{"type":"auth","token":"t-123"}' },
        { type: 'receive', time: 2, opcode: 2, data: 'AAEC' }
      ]
    }),
    entry({ request: { method: 'GET', url: 'https://cdn.example.net/app.js', headers: [{ name: 'Accept', value: '*/*' }] } })
  )
  input.log.pages = [{ id: 'page_1', title: 'https://app.example.com/?session=abc', startedDateTime: '2026-11-15T10:00:00.000Z', pageTimings: {} }]
  const before = JSON.stringify(input)
  const { har: out, report } = sanitizeHar(input)
  assert.equal(JSON.stringify(input), before, 'the input is not modified')

  const e = out.log.entries![0]
  assert.equal(e.request!.url, `https://api.example.com/v1/login?api_key=${MASK}&lang=en`)
  const headers = Object.fromEntries(e.request!.headers!.map((h) => [h.name, h.value]))
  assert.equal(headers[':path'], `/v1/login?api_key=${MASK}&lang=en`)
  assert.equal(headers.Authorization, `Bearer ${MASK}`)
  assert.equal(headers.Cookie, `sid=${MASK}; theme=${MASK}`)
  assert.equal(headers['X-API-Key'], MASK)
  assert.equal(headers.Accept, 'application/json')
  assert.equal(e.request!.cookies![0].value, MASK)
  assert.deepEqual(e.request!.queryString, [
    { name: 'api_key', value: MASK },
    { name: 'lang', value: 'en' }
  ])
  assert.equal(JSON.parse(e.request!.postData!.text!).password, MASK)
  assert.equal(e.response!.headers![0].value, `sid=${MASK}; Path=/; HttpOnly`)
  assert.equal(e.response!.cookies![0].value, MASK)
  assert.equal(e.response!.cookies![0].httpOnly, true)
  assert.equal(e.response!.content!.encoding, 'base64')
  const body = JSON.parse(new TextDecoder().decode(decodeBase64(e.response!.content!.text!)!))
  assert.deepEqual(body, { access_token: MASK, expires_in: 3600 })
  const initiator = e._initiator as { stack: { callFrames: { url: string }[] } }
  assert.equal(initiator.stack.callFrames[0].url, `https://app.example.com/app.js?token=${MASK}`)
  assert.equal(JSON.parse(e._webSocketMessages![0].data!).token, MASK)
  assert.equal(e._webSocketMessages![1].data, 'AAEC', 'binary frames are left alone')
  assert.equal(out.log.pages![0].title, `https://app.example.com/?session=${MASK}`)

  // The second entry has nothing to mask and comes back as the same object.
  assert.equal(out.log.entries![1].request!.url, 'https://cdn.example.net/app.js')
  assert.deepEqual([...report.entries], [0])
  assert.ok(report.headers >= 2)
  assert.ok(report.cookies >= 4)
  assert.equal(report.query, 1)
  assert.ok(report.bodies >= 3)
  assert.equal(report.total, report.headers + report.cookies + report.query + report.bodies + report.other)

  // Masking twice changes nothing more.
  const again = sanitizeHar(out)
  assert.equal(JSON.stringify(again.har), JSON.stringify(out))
})

test('binary bodies and timings are never touched', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41, 0x4b, 0x49, 0x41])
  const input = har(
    entry({
      response: {
        status: 200,
        content: { size: png.length, mimeType: 'image/png', encoding: 'base64', text: encodeBase64(png) }
      }
    })
  )
  const { har: out, report } = sanitizeHar(input)
  assert.equal(out.log.entries![0].response!.content!.text, input.log.entries![0].response!.content!.text)
  assert.deepEqual(out.log.entries![0].timings, input.log.entries![0].timings)
  assert.equal(report.total, 0)
})

test('.har.zip body files: text is masked, binary kept', () => {
  const c = counter()
  const text = new TextEncoder().encode('{"token":"abc","n":1}')
  assert.equal(new TextDecoder().decode(sanitizeSideFile(text, 'application/json', c)), `{"token":"${MASK}","n":1}`)
  const binary = new Uint8Array([1, 2, 3])
  assert.equal(sanitizeSideFile(binary, 'application/octet-stream', c), binary)
})
