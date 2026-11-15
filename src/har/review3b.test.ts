// Regression tests for the masking re-check of round 3 (VERIFY.md, items in the test names).
// Every fixture is built here from obviously fake values.

import { assert, test } from 'orca/testing'
import type { SideFiles } from './body'
import { toCurl, toFetch } from './copy'
import { buildDigest } from './digest'
import { formFields, queryFields } from './fields'
import { isIdName } from './mask-text'
import { maskRecording } from './masked'
import { buildModel } from './model'
import { MASK, maskHeaderValue, maskUrl, sanitizeHar, type Counter } from './sanitize'
import type { Har, HarEntry } from './types'

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

const get = (url: string, headers: { name: string; value: string }[] = []): HarEntry => ({
  request: { method: 'GET', url, headers },
  response: { status: 200, headers: [] }
})

const json = (url: string, body: unknown): HarEntry => ({
  request: { method: 'POST', url, headers: [] },
  response: { status: 200, headers: [], content: { mimeType: 'application/json', text: JSON.stringify(body) } }
})

/** Everything a masked recording shows: the file, the digest, and cURL and fetch of every request. */
function shown(masked: Har): string {
  const model = buildModel(masked)
  const entries = masked.log.entries ?? []
  return [
    JSON.stringify(masked),
    buildDigest(model, model.entries, { title: 't', bodies: true }),
    ...entries.map((e) => toCurl(e) ?? ''),
    ...entries.map((e) => toFetch(e) ?? ''),
    ...entries.map((e) => JSON.stringify([queryFields(e, e.request?.url ?? ''), formFields(e)]))
  ].join('\n')
}

// A session ID that is also the cookie value, and an order ID: both random to the catch-all.
const V = ['k7q2m9x4p1', 'z8w3n6r5t0', 'v2b4c8d1f3'].join('')
const ORDER = ['ord_8f2a91', 'c7d3e4b5a6', 'c7d8'].join('')

test('re-check 1: an id inside a secret-named object is never learned, so the value stays masked elsewhere', () => {
  const uses = [
    get(`https://api.example.com/api/sessions/${V}`),
    get(`https://api.example.com/api/x?ref=${V}`),
    get('https://api.example.com/api/y', [{ name: 'X-Client-State', value: V }]),
    json('https://api.example.com/api/z', { lastSession: V })
  ]
  for (const body of [{ session: { id: V } }, { access: { token: { id: V } } }, { sessions: [{ id: V }] }, { auth: { user: { id: V } } }]) {
    const source = json('https://api.example.com/api/session', body)
    for (const input of [har(source, ...uses), har(...uses, source)]) {
      const out = sanitizeHar(input).har
      assert.ok(!shown(out).includes(V), JSON.stringify(body))
    }
    // A .har.zip with the body in a file, first and last.
    const fileEntry: HarEntry = { ...source, response: { status: 200, headers: [], content: { mimeType: 'application/json', size: 60, _file: 'session.json' } } }
    const bytes = new TextEncoder().encode(JSON.stringify(body))
    const files: SideFiles = { has: (name) => name === 'session.json', get: (name) => (name === 'session.json' ? bytes : null), size: () => bytes.length }
    for (const input of [har(fileEntry, ...uses), har(...uses, fileEntry)]) {
      const masked = maskRecording(input, files)
      assert.ok(!shown(masked.har).includes(V), `zip ${JSON.stringify(body)}`)
      assert.ok(!new TextDecoder().decode(masked.files!.get('session.json')!).includes(V))
    }
  }
  // The control: an ID under a plain object is kept in the path, as finding 6 asked.
  const kept = sanitizeHar(har(get(`https://api.example.com/v1/orders/${ORDER}`), json('https://api.example.com/v1/orders', { order: { id: ORDER } }))).har
  assert.equal(kept.log.entries![0].request?.url, `https://api.example.com/v1/orders/${ORDER}`)
})

test('re-check 2: a SignalR connection token is masked as ?id= on every transport URL', () => {
  const token = ['Hq7Lm2Np4R', 's8Tv1Wx3Yz', '5B'].join('')
  const negotiate: HarEntry = {
    request: { method: 'POST', url: 'https://app.example.com/_blazor/negotiate?negotiateVersion=1', headers: [] },
    response: { status: 200, headers: [], content: { mimeType: 'application/json', text: JSON.stringify({ negotiateVersion: 1, connectionId: 'Lw2xQ8nP0aR5', connectionToken: token, availableTransports: [] }) } }
  }
  const socket = get(`wss://app.example.com/_blazor?id=${token}`)
  const poll: HarEntry = {
    request: { method: 'POST', url: `https://app.example.com/_blazor?id=${token}&_=1731660072000`, headers: [{ name: ':path', value: `/_blazor?id=${token}&_=1731660072000` }], queryString: [{ name: 'id', value: token }, { name: '_', value: '1731660072000' }], postData: { mimeType: 'text/plain;charset=UTF-8', text: '{"protocol":"json","version":1}\u001e' } },
    response: { status: 200, headers: [] }
  }
  const page = get('https://app.example.com/counter', [{ name: 'Referer', value: `https://app.example.com/_blazor?id=${token}` }])
  for (const input of [har(negotiate, socket, poll, page), har(socket, poll, page, negotiate)]) {
    const out = sanitizeHar(input).har
    assert.ok(!shown(out).includes(token), shown(out))
    assert.equal(out.log.entries!.find((e) => e.request?.url?.startsWith('wss:'))?.request?.url, `wss://app.example.com/_blazor?id=${MASK}`)
    // The shareable connection ID stays.
    assert.ok(JSON.stringify(out).includes('Lw2xQ8nP0aR5'))
  }
  // No negotiate response recorded: the sibling path alone says it is a hub.
  const bare: HarEntry = { request: { method: 'POST', url: 'https://app.example.com/hubs/chat/negotiate', headers: [] }, response: { status: 200, headers: [] } }
  const transport = sanitizeHar(har(bare, get(`wss://app.example.com/hubs/chat?id=${token}`))).har.log.entries![1].request?.url
  assert.equal(transport, `wss://app.example.com/hubs/chat?id=${MASK}`)
  // The token a body named is masked under any parameter name, on any path.
  const elsewhere = sanitizeHar(har(negotiate, get(`https://app.example.com/other?conn=${token}`))).har.log.entries![1].request?.url
  assert.equal(elsewhere, `https://app.example.com/other?conn=${MASK}`)
  // `id` on ordinary URLs stays an identifier.
  assert.equal(maskUrl('https://app.example.com/orders?id=48207', counter()), 'https://app.example.com/orders?id=48207')
  assert.equal(sanitizeHar(har(negotiate, get('https://app.example.com/items?id=Zk3qP9vX2mL7tR4wB8nC5yH1'))).har.log.entries![1].request?.url, 'https://app.example.com/items?id=Zk3qP9vX2mL7tR4wB8nC5yH1')
})

test('re-check 3: a credential word before an id word makes the name a credential, not an id', () => {
  for (const name of ['X-Auth-Id', 'auth_id', 'authId', 'auth_req_id', 'auth_hash', 'auth_version', 'mfa_id', 'pwd_id', 'pin_id', 'ssn_id', 'X-Shopify-Hmac-Sha256', 'otp_id', 'sig_hash']) {
    assert.equal(isIdName(name), false, name)
  }
  for (const name of ['id', 'requestId', 'X-Request-Id', 'author_id', 'pinned_id', 'passenger_id', 'node_id', 'etag', 'build', 'X-Amz-Version-Id']) {
    assert.equal(isIdName(name), true, name)
  }
  const random = 'Zk3qP9vX2mL7tR4wB8nC5yH1aQ6'
  const hmac = ['qqXc0FAf7h', 'Ff3sTKVsVq', '0KxN8ZQhD4', 'MFoO7yFsfAk='].join('')
  assert.equal(maskHeaderValue('X-Auth-Id', random, counter()), MASK)
  assert.equal(maskHeaderValue('X-Shopify-Hmac-Sha256', hmac, counter()), MASK)
  assert.equal(maskHeaderValue('X-Request-Id', random, counter()), random)
  // In JSON the value is judged as any other: random, so masked, in the body and in a later path.
  const out = sanitizeHar(har(json('https://api.example.com/bc-authorize', { auth_req_id: random }), get(`https://api.example.com/poll/${random}`))).har
  assert.ok(!JSON.stringify(out).includes(random))
})

test('re-check 4: Content-Type keeps its boundary and charset only; other random parameters are masked', () => {
  const random = 'Zk3qP9vX2mL7tR4wB8nC5yH1aQ6'
  const kept = ['multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW', 'multipart/mixed; boundary="batch_8f2a91c7d3e4b5a6c7d8e9f0"', 'text/html; charset=utf-8', 'application/json']
  for (const value of kept) assert.equal(maskHeaderValue('Content-Type', value, counter()), value)
  assert.equal(maskHeaderValue('Content-Type', `application/octet-stream; nonce=${random}`, counter()), `application/octet-stream; nonce=${MASK}`)
  assert.equal(maskHeaderValue('content-type', `application/x-foo; x=${random}`, counter()), `application/x-foo; x=${MASK}`)
  assert.equal(maskHeaderValue('Content-Type', `text/plain; ${random}`, counter()), `text/plain; ${MASK}`)
  assert.equal(maskHeaderValue('Content-Type', `multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW; key=abc`, counter()), `multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW; key=${MASK}`)
})

test('re-check 5: JSON that does not parse in a query or form value is masked by key name all the same', () => {
  const cases = [
    '{"email":"a@b.c","password":"hunter2xyz"',
    "{'password':'hunter2xyz'}",
    '{password:"hunter2xyz"}',
    '{"password":"hunter2xyz",}',
    '{password: hunter2xyz, remember: true}',
    "[{pin: 4821, label: 'home'}"
  ]
  for (const value of cases) {
    const url = `https://api.example.com/graphql?v=${encodeURIComponent(value)}`
    const c = counter()
    const masked = maskUrl(url, c)
    const decoded = decodeURIComponent(masked.slice(masked.indexOf('=') + 1))
    assert.ok(!decoded.includes('hunter2xyz') && !decoded.includes('4821'), decoded)
    assert.ok(decoded.includes(MASK) && c.n === 1, decoded)
    // Unchanged around the secret: the email, booleans and the plain label stay.
    if (value.includes('a@b.c')) assert.ok(decoded.includes('a@b.c'))
    if (value.includes('remember')) assert.ok(decoded.includes('remember: true'))
    if (value.includes('home')) assert.ok(decoded.includes("'home'"))
    // Raw braces, and an urlencoded form field.
    assert.ok(!maskUrl(`https://api.example.com/q?v=${value}`, counter()).includes('hunter2xyz'))
    const form: HarEntry = {
      request: { method: 'POST', url: 'https://api.example.com/form', headers: [], postData: { mimeType: 'application/x-www-form-urlencoded', text: `state=${encodeURIComponent(value)}&x=1` } },
      response: { status: 200, headers: [] }
    }
    const out = sanitizeHar(har(form)).har
    assert.ok(!shown(out).includes('hunter2xyz') && !shown(out).includes('4821'), value)
  }
  // Text that only starts with a bracket is left as it was.
  assert.equal(maskUrl('https://api.example.com/q?tag=[1,2', counter()), 'https://api.example.com/q?tag=[1,2')
})

test('re-check 6: in a .har.zip, an ID one body file names keeps another file that came before it', () => {
  const plain = (file: string): HarEntry => ({ request: { method: 'GET', url: `https://api.example.com/${file}`, headers: [] }, response: { status: 200, headers: [], content: { mimeType: 'application/json', size: 50, _file: file } } })
  const bodies: Record<string, Uint8Array> = {
    'a.json': new TextEncoder().encode(JSON.stringify({ lastOrder: ORDER })),
    'b.json': new TextEncoder().encode(JSON.stringify({ id: ORDER, total: 35.14 }))
  }
  const files: SideFiles = { has: (name) => name in bodies, get: (name) => bodies[name] ?? null, size: (name) => bodies[name]?.length ?? 0 }
  const masked = maskRecording(har(plain('a.json'), plain('b.json')), files)
  assert.equal(new TextDecoder().decode(masked.files!.get('a.json')!), JSON.stringify({ lastOrder: ORDER }))
  // The same recording with inline bodies masks alike.
  const inline = sanitizeHar(har(json('https://api.example.com/a', { lastOrder: ORDER }), json('https://api.example.com/b', { id: ORDER }))).har
  assert.equal(inline.log.entries![0].response?.content?.text, JSON.stringify({ lastOrder: ORDER }))
})
