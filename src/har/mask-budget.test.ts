// Time budgets for masking (review findings 4 and 15): every pattern runs on untrusted text, so
// 100 KB built to make a backtracking pattern blow up must still be masked in well under a second.

import { assert, test } from 'orca/testing'
import { encodeBase64 } from './body'
import { reindentJson } from './json-text'
import { maskBodyBytes, maskBodyText, maskFreeText, maskText, maskUrl, sanitizeHar, type Counter } from './sanitize'
import type { Har } from './types'

const BUDGET_MS = 200
const SIZE = 100_000
const quiet: Counter = { add: () => undefined }

const fill = (unit: string, size = SIZE) => unit.repeat(Math.ceil(size / unit.length))

/** Adversarial inputs: one per pattern or parser path, named after what they attack. */
const INPUTS: Record<string, string> = {
  'JWT run': fill('eyJ'),
  'JWT pieces': fill('eyJaaaa.eyJ'),
  'sk- run': fill('sk-'),
  'Slack run': fill('xoxb-'),
  'private key without an end': `-----BEGIN PRIVATE KEY-----${fill('-----END AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ')}`,
  'Bearer with a long upper-case value': `Bearer ${fill('A')}`,
  'Token with a long lower-case value': `Token ${fill('a')}`,
  'Bearer, repeated': fill('Bearer '),
  'Bearer with long spaces': `Bearer${fill(' ')}`,
  'scheme-like dots': fill('a.'),
  'URL password without @': `a://${fill('b:')}`,
  'URL schemes, repeated': fill('a://'),
  'meta tags without an end': fill('<meta '),
  'input tags with names': fill('<input name="token" value="'),
  'pairs without values': fill('?a'),
  'nested pairs': `a=${fill('a=')}`,
  'equals signs': fill('='),
  'encoded nested URLs': `next=${fill('%3Fnext%3D')}`,
  'quoted pair, unclosed': `password: "${fill('x')}`,
  'quoted pairs, unclosed and repeated': fill('a: "'),
  'quoted pair, backslashes': `token = '${fill('\\')}`,
  'long word': fill('a'),
  'form, 40 fields and a newline': `${Array.from({ length: 40 }, (_, i) => `f${i}=v${i}`).join('&')}\n${fill('&a=')} `,
  'form-like with spaces': `${fill('a=b&')} `,
  'multipart delimiters': fill('--b\r\n'),
  'SignalR separators': fill('\u001e'),
  'Socket.IO prefix and brackets': `42${fill('[')}`,
  'unclosed JSON': `{"a":${fill('[')}`,
  'JSON with many strings': `[${fill('"https://x.example.com/?token=abc&next=%2Fa%3Fb%3Dc",').slice(0, -1)}]`,
  'deep JSON': `${fill('[', SIZE / 2)}${fill(']', SIZE / 2)}`
}

function timed(run: () => unknown): number {
  const start = performance.now()
  run()
  return performance.now() - start
}

test('review 4, 15: masking text, bodies and URLs stays linear on adversarial input', () => {
  const slow: string[] = []
  for (const [name, text] of Object.entries(INPUTS)) {
    for (const [how, run] of [
      ['text', () => maskText(text, quiet)],
      ['body', () => maskBodyText(text, '', quiet)],
      ['form body', () => maskBodyText(text, 'application/x-www-form-urlencoded', quiet)],
      ['multipart body', () => maskBodyText(text, 'multipart/form-data; boundary=b', quiet)],
      ['URL', () => maskUrl(`https://x.example.com/p;${text}?q=${text}#${text}`, quiet)],
      ['free text', () => maskFreeText(`/${text}`, quiet)]
    ] as const) {
      const ms = timed(run)
      if (ms > BUDGET_MS) slow.push(`${name} as ${how}: ${Math.round(ms)} ms`)
    }
  }
  assert.deepEqual(slow, [])
})

test('review 4: a form-shaped WebSocket frame and a POST body with no type mask in time', () => {
  const frame = `${Array.from({ length: 40 }, (_, i) => `f${i}=v${i}`).join('&')}\n`
  const har: Har = {
    log: {
      version: '1.2',
      creator: { name: 'test' },
      entries: [
        {
          request: { method: 'POST', url: 'wss://x.example.com/ws', postData: { text: frame } },
          response: { status: 101 },
          _webSocketMessages: [{ type: 'send', time: 1, opcode: 1, data: frame }]
        }
      ]
    }
  }
  assert.ok(timed(() => sanitizeHar(har)) < BUDGET_MS)
})

test('review 15: byte bodies and the lossless indenter stay linear', () => {
  const bytes = new TextEncoder().encode(INPUTS['JWT run'])
  assert.ok(timed(() => maskBodyBytes(bytes, 'application/octet-stream', quiet)) < BUDGET_MS)
  const latin = new Uint8Array(SIZE).fill(0xe9)
  assert.ok(timed(() => maskBodyBytes(latin, 'text/plain; charset=windows-1252', quiet)) < BUDGET_MS)
  assert.ok(timed(() => maskBodyBytes(latin, 'text/plain', quiet)) < BUDGET_MS)
  assert.ok(timed(() => encodeBase64(bytes)) < BUDGET_MS)
  assert.ok(timed(() => reindentJson(INPUTS['JSON with many strings'])) < BUDGET_MS)
})
