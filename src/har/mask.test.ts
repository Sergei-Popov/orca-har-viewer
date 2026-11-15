// Regression tests for the masking findings of the 0.1.0 review (numbers in the test names).
// Every fixture is built here from obviously fake values.

import { assert, test } from 'orca/testing'
import { zipSync } from '../../vendor/fflate/fflate.mjs'
import { decodeBase64, encodeBase64, requestBody, responseBody } from './body'
import { toCurl, toFetch } from './copy'
import { buildDigest } from './digest'
import { maskedHarText, maskedHarZip, maskRecording } from './masked'
import { buildModel } from './model'
import { MASK, maskBodyBytes, maskBodyText, maskText, maskUrl, sanitizeHar, type Counter } from './sanitize'
import type { Har, HarEntry } from './types'
import { openHarZip } from './zip'

const enc = new TextEncoder()
const dec = new TextDecoder()
const b64 = (text: string) => encodeBase64(enc.encode(text))
const unb64 = (text: string) => dec.decode(decodeBase64(text)!)
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vLXVzZXIifQ.ZGVtby1zaWduYXR1cmUtbm90LXJlYWw'

function counter(): Counter & { n: number } {
  const c = {
    n: 0,
    add(_kind: string, count = 1) {
      c.n += count
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

function response(content: Record<string, unknown>): HarEntry['response'] {
  return { status: 200, statusText: 'OK', headers: [], cookies: [], content }
}

/** The sanitized file's text, and whether any of `secrets` survived anywhere in it. */
function leaks(input: Har, ...secrets: string[]): string[] {
  const text = maskedHarText(maskRecording(input))
  const decodedBodies = (sanitizeHar(input).har.log.entries ?? [])
    .map((e) => {
      const r = responseBody(e)
      const q = requestBody(e)
      return [r.kind === 'text' ? r.text : '', q.kind === 'text' ? q.text : ''].join('\n')
    })
    .join('\n')
  return secrets.filter((s) => text.includes(s) || decodedBodies.includes(s))
}

test('review 1, 21: base64 text bodies are masked whatever their MIME type, and stay base64', () => {
  const body = `{"access_token":"s3cr3t-v4lue-0123456789","id_token":"${JWT}"}`
  for (const mimeType of ['application/octet-stream', 'x-unknown', '', 'application/json']) {
    const input = har(entry({ response: response({ mimeType, encoding: 'base64', text: b64(body) }) }))
    const { har: out, report } = sanitizeHar(input)
    const content = out.log.entries![0].response!.content!
    assert.equal(content.encoding, 'base64', mimeType)
    assert.equal(unb64(content.text!), `{"access_token":"${MASK}","id_token":"${MASK}"}`, mimeType)
    assert.equal(report.total, 2, mimeType)
    assert.deepEqual(leaks(input, 's3cr3t-v4lue-0123456789', JWT), [], mimeType)
  }
  // Standard types browsers save as base64.
  const jwt = har(entry({ response: response({ mimeType: 'application/jwt', encoding: 'base64', text: b64(JWT) }) }))
  assert.equal(unb64(sanitizeHar(jwt).har.log.entries![0].response!.content!.text!), MASK)
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCdemo\n-----END PRIVATE KEY-----\n'
  const key = har(entry({ response: response({ mimeType: 'application/x-pem-file', encoding: 'base64', text: b64(pem) }) }))
  assert.equal(unb64(sanitizeHar(key).har.log.entries![0].response!.content!.text!), `${MASK}\n`)
  // A request body with no type.
  const post = har(entry({ request: { method: 'POST', url: 'https://api.example.com/x', postData: { mimeType: '', encoding: 'base64', text: b64('{"password":"REQB64NOMIME"}') } } }))
  const masked = sanitizeHar(post).har.log.entries![0]
  assert.ok(!toCurl(masked).includes('REQB64NOMIME'))
  // Binary stays byte for byte.
  const binary = new Uint8Array([0, 1, 2, 3, 0xff, 0x10, 0x41, 0x4b, 0x49, 0x41])
  const bin = har(entry({ response: response({ mimeType: 'application/octet-stream', encoding: 'base64', text: encodeBase64(binary) }) }))
  assert.equal(sanitizeHar(bin).har.log.entries![0].response!.content!.text, encodeBase64(binary))
})

test('review 1, 21: .har.zip body files with an unknown or missing type are masked too', () => {
  const recording: Har = har(
    entry({ request: { method: 'GET', url: 'https://api.example.com/a' }, response: response({ mimeType: 'x-unknown', _file: 'a.bin' }) }),
    entry({ request: { method: 'GET', url: 'https://api.example.com/b' }, response: response({ mimeType: '', _file: 'b.dat' }) }),
    entry({ request: { method: 'GET', url: 'https://api.example.com/c' }, response: response({ mimeType: 'application/octet-stream', _file: 'c.bin' }) })
  )
  const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 1, 2])
  const zip = openHarZip(
    zipSync({
      'har.har': enc.encode(JSON.stringify(recording)),
      'a.bin': enc.encode('{"token":"ZIPXUNKNOWN0123"}'),
      'b.dat': enc.encode('{"password":"ZIPNOMIME0123"}'),
      'c.bin': raw
    })
  )
  const masked = maskRecording(recording, zip.files)
  assert.equal(masked.report.total, 2)
  assert.equal(dec.decode(masked.files!.get('a.bin')!), `{"token":"${MASK}"}`)
  assert.equal(dec.decode(masked.files!.get('b.dat')!), `{"password":"${MASK}"}`)
  assert.equal(masked.files!.get('c.bin'), zip.files.get('c.bin'), 'binary is passed through')
  const saved = openHarZip(maskedHarZip(masked))
  assert.ok(!dec.decode(saved.files.get('a.bin')!).includes('ZIPXUNKNOWN0123'))
  assert.ok(!dec.decode(saved.files.get('b.dat')!).includes('ZIPNOMIME0123'))
  assert.deepEqual(Array.from(saved.files.get('c.bin')!), Array.from(raw))
})

test('review 1: byte bodies come back in the encoding they came in', () => {
  // UTF-8 with a byte order mark and non-ASCII text.
  const utf8 = enc.encode('﻿{"name":"Ёжик","token":"abcdef123456"}')
  const out = maskBodyBytes(utf8, 'application/json', counter())
  assert.equal(new TextDecoder('utf-8', { ignoreBOM: true }).decode(out), `﻿{"name":"Ёжик","token":"${MASK}"}`)
  // windows-1251 stays windows-1251.
  const cp1251 = new Uint8Array([...enc.encode('{"name":"'), 0xc5, 0xe6, ...enc.encode('","token":"abcdef123456"}')])
  const masked = maskBodyBytes(cp1251, 'application/json; charset=windows-1251', counter())
  assert.deepEqual(Array.from(masked.subarray(0, 11)), Array.from(cp1251.subarray(0, 11)))
  assert.equal(new TextDecoder('windows-1251').decode(masked), `{"name":"Еж","token":"${MASK}"}`)
  // Invalid UTF-8 under a text type: every byte but the secret survives.
  const broken = new Uint8Array([...enc.encode('note '), 0xff, 0xfe, ...enc.encode(' password=hunter2xyz end')])
  const kept = maskBodyBytes(broken, 'text/plain', counter())
  assert.deepEqual(Array.from(kept.subarray(0, 8)), Array.from(broken.subarray(0, 8)))
  assert.ok(!dec.decode(kept).includes('hunter2xyz'))
})

test('review 2: an OAuth code is masked in queryString as well as in the URL', () => {
  const input = har(
    entry({
      request: {
        method: 'GET',
        url: 'https://app.example.com/oauth/callback?code=4%2F0AbCdOAUTHCODE&state=xyz',
        queryString: [
          { name: 'code', value: '4%2F0AbCdOAUTHCODE' },
          { name: 'state', value: 'xyz' }
        ]
      }
    }),
    entry({
      request: { method: 'GET', url: 'https://app.example.com/login?code=SplxlOBeZQQYbYS6WxSbIA', queryString: [{ name: 'code', value: 'SplxlOBeZQQYbYS6WxSbIA' }] }
    }),
    // Decoded values, as Firefox writes them, and an OAuth flow told by its parameters alone.
    entry({ request: { method: 'GET', url: 'https://app.example.com/done?code=a%2Fb123456&state=s', queryString: [{ name: 'code', value: 'a/b123456' }, { name: 'state', value: 's' }] } })
  )
  const out = sanitizeHar(input).har.log.entries!
  assert.deepEqual(out[0].request!.queryString, [
    { name: 'code', value: MASK },
    { name: 'state', value: 'xyz' }
  ])
  assert.equal(out[1].request!.queryString![0].value, MASK)
  assert.equal(out[2].request!.queryString![0].value, MASK)
  assert.deepEqual(leaks(input, '0AbCdOAUTHCODE', 'SplxlOBeZQQYbYS6WxSbIA', 'a/b123456'), [])
  // Not an OAuth flow: a product code stays.
  assert.equal(maskUrl('https://shop.example.com/products?code=US&sort=asc', counter()), 'https://shop.example.com/products?code=US&sort=asc')
})

test('review 3: multipart/form-data parts are masked by name, everything else kept byte for byte', () => {
  const boundary = '----WebKitFormBoundaryDEMO12345'
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="username"',
    '',
    'demo-user',
    `--${boundary}`,
    'Content-Disposition: form-data; name="password"',
    '',
    'Hunter2Secret!',
    `--${boundary}`,
    'Content-Disposition: form-data; name="csrf_token"',
    '',
    'CSRFVALUE123',
    `--${boundary}`,
    'Content-Disposition: form-data; name="meta"',
    'Content-Type: application/json',
    '',
    '{"note":"x","apiKey":"PARTJSONKEY1"}',
    `--${boundary}--`,
    ''
  ].join('\r\n')
  const mimeType = `multipart/form-data; boundary=${boundary}`
  const c = counter()
  const out = maskBodyText(body, mimeType, c)
  assert.equal(out, body.replace('Hunter2Secret!', MASK).replace('CSRFVALUE123', MASK).replace('PARTJSONKEY1', MASK))
  assert.equal(c.n, 3)
  for (const params of [undefined, [{ name: 'password', value: 'Hunter2Secret!' }, { name: 'csrf_token', value: 'CSRFVALUE123' }]]) {
    const input = har(entry({ request: { method: 'POST', url: 'https://app.example.com/api/login', postData: { mimeType, text: body, params } } }))
    const masked = sanitizeHar(input).har
    const e = masked.log.entries![0]
    for (const text of [toCurl(e), toFetch(e), buildDigest(buildModel(masked), buildModel(masked).entries, { title: 't', bodies: true }), maskedHarText(maskRecording(input))]) {
      assert.ok(!text.includes('Hunter2Secret!') && !text.includes('CSRFVALUE123'))
    }
  }
  // Base64, with a binary file part that must survive unchanged.
  const file = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0xfe, 0x0d, 0x0a, 0x2d, 0x2d])
  const multipart = (password: string) =>
    new Uint8Array([
      ...enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
      ...file,
      ...enc.encode(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="password"\r\n\r\n${password}\r\n--${boundary}--\r\n`)
    ])
  const bytes = multipart('B64PARTPASS')
  assert.deepEqual(Array.from(maskBodyBytes(bytes, mimeType, counter())), Array.from(multipart(MASK)))
  const posted = har(entry({ request: { method: 'POST', url: 'https://app.example.com/upload', postData: { mimeType, encoding: 'base64', text: encodeBase64(bytes) } } }))
  const saved = sanitizeHar(posted).har.log.entries![0].request!.postData!
  assert.equal(saved.encoding, 'base64')
  assert.deepEqual(Array.from(decodeBase64(saved.text!)!), Array.from(multipart(MASK)))
})

test('review 6, 5, 7: page titles that are URLs are masked as URLs, OAuth codes included', () => {
  const input = har(entry({ pageref: 'page_1', request: { method: 'GET', url: 'https://app.example.com/auth/callback?code=PAGETITLECODEval&state=st1' } }))
  input.log.pages = [
    { id: 'page_1', title: 'https://app.example.com/auth/callback?code=PAGETITLECODEval&state=st1', startedDateTime: '2026-11-15T10:00:00.000Z', pageTimings: {} },
    { id: 'page_2', title: 'https://app.example.com/reset?token=8f3a9c2e7b1d4f60', startedDateTime: '2026-11-15T10:00:01.000Z', pageTimings: {} }
  ]
  const masked = sanitizeHar(input).har
  assert.equal(masked.log.pages![0].title, `https://app.example.com/auth/callback?code=${MASK}&state=st1`)
  assert.equal(masked.log.pages![1].title, `https://app.example.com/reset?token=${MASK}`)
  const model = buildModel(masked)
  assert.deepEqual(model.pages.map((p) => p.title.includes(MASK)), [true, true], 'the page menu reads these titles')
  const one = har(entry({ pageref: 'page_1' }))
  one.log.pages = [input.log.pages[0]]
  const digest = buildDigest(buildModel(sanitizeHar(one).har), [], { title: 't', bodies: false })
  assert.ok(!digest.includes('PAGETITLECODEval'))
})

test('review 8: name=value pairs at the start of text, after spaces, and inside values', () => {
  const c = counter()
  assert.equal(maskBodyText('password=TEXTPLAINPASSval&user=x', 'text/plain;charset=UTF-8', c), `password=${MASK}&user=x`)
  assert.equal(maskText('password=STARTval', counter()), `password=${MASK}`)
  assert.equal(maskText('my password=FREETEXTval here', counter()), `my password=${MASK} here`)
  assert.equal(
    maskBodyText('oauth_token=OTOKval&oauth_token_secret=OSECRETval&oauth_callback_confirmed=true', 'text/html', counter()),
    `oauth_token=${MASK}&oauth_token_secret=${MASK}&oauth_callback_confirmed=true`
  )
  const input = har(entry({ request: { method: 'POST', url: 'https://api.example.com/x', postData: { mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'note', value: 'token=PARAMSINNERval' }] } } }))
  assert.deepEqual(leaks(input, 'PARAMSINNERval'), [])
  // Code and comparisons are not pairs.
  assert.equal(maskText('function f(a){return a.key===b.key}', counter()), 'function f(a){return a.key===b.key}')
})

test('review 9: URLs nested in query values are masked and encoded back the way they came', () => {
  assert.equal(
    maskUrl('https://app.example.com/login?next=%2Freset-password%3Ftoken%3DRESETTOKEN123', counter()),
    `https://app.example.com/login?next=%2Freset-password%3Ftoken%3D${MASK}`
  )
  assert.equal(
    maskUrl('https://app.example.com/login?next=/reset-password?token=RESETTOKEN456', counter()),
    `https://app.example.com/login?next=/reset-password?token=${MASK}`
  )
  assert.equal(
    maskUrl('https://app.example.com/go?url=https%3A%2F%2Fapi.example.com%2Fv1%3Faccess_token%3DINNERACCESS789&x=1', counter()),
    `https://app.example.com/go?url=https%3A%2F%2Fapi.example.com%2Fv1%3Faccess_token%3D${MASK}&x=1`
  )
  assert.equal(
    maskUrl('https://idp.example.com/authorize?redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb%3Fsession%3DNESTEDSESSION1&state=s', counter()),
    `https://idp.example.com/authorize?redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb%3Fsession%3D${MASK}&state=s`
  )
  // Free text and headers too.
  assert.ok(!maskText('see https://app.example.com/login?next=/reset?token=FREETEXTNESTED1', counter()).includes('FREETEXTNESTED1'))
  const input = har(entry({ request: { method: 'GET', url: 'https://app.example.com/', headers: [{ name: 'Referer', value: 'https://app.example.com/login?next=%2Freset%3Ftoken%3DREFERERNESTED1' }] } }))
  assert.deepEqual(leaks(input, 'REFERERNESTED1'), [])
  // A plain nested path stays as it was.
  assert.equal(maskUrl('https://app.example.com/login?next=%2Fdashboard%3Ftab%3D2', counter()), 'https://app.example.com/login?next=%2Fdashboard%3Ftab%3D2')
})

test('review 10: OAuth and SAML credentials in forms, form_post HTML and redirects', () => {
  const token = har(
    entry({
      request: {
        method: 'POST',
        url: 'https://idp.example.com/oauth/token',
        postData: {
          mimeType: 'application/x-www-form-urlencoded',
          text: 'grant_type=authorization_code&code=FORMCODEval&code_verifier=FORMVERIFIERval&client_id=demo',
          params: [
            { name: 'grant_type', value: 'authorization_code' },
            { name: 'code', value: 'FORMCODEval' },
            { name: 'code_verifier', value: 'FORMVERIFIERval' }
          ]
        }
      }
    })
  )
  const e = sanitizeHar(token).har.log.entries![0]
  assert.equal(e.request!.postData!.text, `grant_type=authorization_code&code=${MASK}&code_verifier=${MASK}&client_id=demo`)
  assert.ok(!toCurl(e).includes('FORMCODEval'))
  // A token exchange posted to a path that says nothing: the fields tell.
  assert.equal(maskBodyText('grant_type=authorization_code&code=PLAINPATHCODE1', 'application/x-www-form-urlencoded', counter()), `grant_type=authorization_code&code=${MASK}`)
  const html = '<form method="post" action="https://app.example.com/cb"><input type="hidden" name="code" value="HTMLFORMPOSTCODEval"/><input type="hidden" name="state" value="st"/></form>'
  assert.ok(!maskBodyText(html, 'text/html', counter()).includes('HTMLFORMPOSTCODEval'))
  const saml = '<input type="hidden" name="SAMLResponse" value="PHNhbWxwOlJlc3BvbnNlIGRlbW89InllcyIvPg=="/>'
  assert.ok(!maskBodyText(saml, 'text/html', counter()).includes('PHNhbWxwOlJlc3BvbnNl'))
  assert.equal(maskBodyText('SAMLResponse=SAMLRESPONSEval&RelayState=r', 'application/x-www-form-urlencoded', counter()), `SAMLResponse=${MASK}&RelayState=r`)
  assert.equal(maskUrl('https://idp.example.com/sso?SAMLRequest=SAMLREQUESTval', counter()), `https://idp.example.com/sso?SAMLRequest=${MASK}`)
  assert.equal(maskBodyText('{"passcode":"123456","auth_code":"AC1"}', 'application/json', counter()), `{"passcode":"${MASK}","auth_code":"${MASK}"}`)
})

test('review 11: SignalR and Socket.IO frames are masked as the JSON inside them', () => {
  const frames: [string, string][] = [
    [
      '{"type":1,"target":"Login","arguments":[{"user":"a","pin":98765,"apiKey":["SIGNALRKEY1"]}]}\u001e',
      `{"type":1,"target":"Login","arguments":[{"user":"a","pin":"${MASK}","apiKey":["${MASK}"]}]}\u001e`
    ],
    [
      '{"protocol":"json","version":1}\u001e{"type":1,"arguments":[{"secret":42424242}]}\u001e',
      `{"protocol":"json","version":1}\u001e{"type":1,"arguments":[{"secret":"${MASK}"}]}\u001e`
    ],
    ['42["message","{\\"type\\":\\"auth\\",\\"token\\":\\"SIOESCAPED123\\"}"]', `42["message","{\\"type\\":\\"auth\\",\\"token\\":\\"${MASK}\\"}"]`],
    ['42["login",{"user":"a","pin":13579}]', `42["login",{"user":"a","pin":"${MASK}"}]`],
    ['42/chat,7["auth",{"auth":{"clientId":"cid-1","clientCode":"zzTOPsecretzz"}}]', `42/chat,7["auth",{"auth":{"clientId":"${MASK}","clientCode":"${MASK}"}}]`]
  ]
  for (const [frame, expected] of frames) {
    const input = har(entry({ _webSocketMessages: [{ type: 'send', time: 1, opcode: 1, data: frame }] }))
    assert.equal(sanitizeHar(input).har.log.entries![0]._webSocketMessages![0].data, expected)
  }
})

test('review 13: masking JSON changes only the masked values: 64-bit integers, order, escapes and spacing stay', () => {
  const text = '{"id":1234567890123456789,"id_str":"1234567890123456789","price":1.10,"big":1e3,"10":"x","2":"y","html":"\\u003cb\\u003e","token":"abc"}'
  const c = counter()
  assert.equal(maskBodyText(text, 'application/json', c), text.replace('"token":"abc"', `"token":"${MASK}"`))
  assert.equal(c.n, 1)
  const pretty = '{\n    "a" : 1.50,\n\t"password": "x",\n    "list": [ 1, 2 ]\n}\n'
  assert.equal(maskBodyText(pretty, 'application/json', counter()), pretty.replace('"x"', `"${MASK}"`))
  // A changed string keeps the escaping style of the original.
  assert.equal(maskBodyText('{"u":"https:\\/\\/x.example.com\\/?token=abcdef"}', 'application/json', counter()), `{"u":"https:\\/\\/x.example.com\\/?token=${MASK}"}`)
  // NDJSON too.
  assert.equal(maskBodyText('{"n":12345678901234567890,"token":"t"}\n{"b":2}\n', 'application/x-ndjson', counter()), `{"n":12345678901234567890,"token":"${MASK}"}\n{"b":2}\n`)
  // Deep nesting does not overflow the stack.
  const deep = `${'['.repeat(20000)}"${JWT}"${']'.repeat(20000)}`
  assert.equal(maskBodyText(deep, 'application/json', counter()), `${'['.repeat(20000)}"${MASK}"${']'.repeat(20000)}`)
})

test('review 22: Slack refresh and app tokens; tokens used as JSON keys', () => {
  // Built from pieces, so the fake tokens do not read as live ones to secret scanners.
  const token = (...parts: string[]) => parts.join('')
  assert.equal(maskText(`a ${token('xo', 'xe-1-', 'SHAPESLACKErefresh0123456789')} b`, counter()), `a ${MASK} b`)
  assert.equal(maskText(`a ${token('xa', 'pp-1-', 'A0SHAPESLACKAPP-123-abcdef0123456789')} b`, counter()), `a ${MASK} b`)
  assert.equal(maskText(token('xo', 'xe.', 'xo', 'xp-1-', 'SHAPESLACKRefresh0123456789'), counter()), MASK)
  const key1 = `ghp_${'a'.repeat(36)}`
  const key2 = `ghp_${'b'.repeat(36)}`
  const out = maskBodyText(JSON.stringify({ tokens: { [key1]: { scopes: ['repo'] } }, data: { [key1]: 1, [key2]: 2 } }), 'application/json', counter())
  assert.ok(!out.includes(key1) && !out.includes(key2))
  const parsed = JSON.parse(out)
  assert.deepEqual(Object.keys(parsed.data), [MASK, `${MASK}#2`], 'masked keys stay apart')
})

test('review 23: comments and vendor fields on requests, responses, bodies, headers, cookies and timings', () => {
  const secret = 'sk-ant-api03-COMMENTSHAPE0123456789'
  const input = har(
    entry({
      comment: secret,
      request: {
        method: 'GET',
        url: 'https://api.example.com/',
        comment: `token=REQUESTCOMMENTval ${secret}`,
        headers: [{ name: 'Accept', value: '*/*', comment: secret }],
        cookies: [{ name: 'a', value: 'b', comment: secret }]
      },
      response: {
        status: 500,
        comment: secret,
        _error: 'Bearer abcDEF1234567890xyz',
        content: { mimeType: 'text/plain', text: 'ok', comment: secret, ...{ _vendor: { note: secret } } }
      },
      timings: { send: 1, wait: 2, receive: 3, comment: secret }
    })
  )
  assert.deepEqual(leaks(input, secret, 'REQUESTCOMMENTval', 'abcDEF1234567890xyz'), [])
  const out = sanitizeHar(input).har.log.entries![0]
  assert.equal(out.response!.status, 500)
  assert.equal((out.timings as Record<string, unknown>).wait, 2)
})

test('review 1, 27: binary WebSocket frames whose bytes are text are masked; real binary is kept', () => {
  const input = har(
    entry({
      _webSocketMessages: [
        { type: 'receive', time: 1, opcode: 2, data: b64(`{"token":"${JWT}"}`) },
        { type: 'receive', time: 2, opcode: 2, data: 'AAECAwQ=' }
      ]
    })
  )
  const frames = sanitizeHar(input).har.log.entries![0]._webSocketMessages!
  assert.equal(unb64(frames[0].data!), `{"token":"${MASK}"}`)
  assert.equal(frames[1].data, 'AAECAwQ=')
})
