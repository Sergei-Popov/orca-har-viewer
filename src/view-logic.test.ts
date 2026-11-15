import { assert, test } from 'orca/testing'
import { clockTime, count, dateTime, formatBytes, formatMs, tickStep, wrapPieces } from './format'
import { splitLines, tokenize } from './highlight'
import { parseCookieHeader, parseServerTiming, parseSetCookie, requestCookies, responseCookies } from './har/headers'
import { fill, stringsFor } from './i18n'
import { encodeBase64, parseJson } from './har/body'
import { frameText } from './har/frames'
import { maskRecording } from './har/masked'
import { buildModel } from './har/model'
import { pageChoices } from './ui/choices'
import { hexDump, preview, sourceText } from './ui/viewers'

test('host names and URLs wrap at dots and slashes, never inside a label', () => {
  assert.deepEqual(wrapPieces('api.example.com'), ['api.', 'example.', 'com'])
  assert.deepEqual(wrapPieces('status.example.org'), ['status.', 'example.', 'org'])
  assert.deepEqual(wrapPieces('https://app.example.com/dashboard?tab=1&x=2'), ['https://', 'app.', 'example.', 'com/', 'dashboard?', 'tab=', '1&', 'x=', '2'])
  assert.deepEqual(wrapPieces('localhost'), ['localhost'])
  assert.deepEqual(wrapPieces(''), [])
  // A long label with no punctuation is cut so it cannot widen the table, and nothing is lost.
  const token = 'd3c3cq33003psk7f1x.example.net'
  assert.deepEqual(wrapPieces(token), ['d3c3cq33003p', 'sk7f1x.', 'example.', 'net'])
  for (const text of [token, 'a'.repeat(40), 'Report 🧾 for 2026', 'https://x.test/𝒜𝒜𝒜𝒜𝒜𝒜𝒜𝒜𝒜𝒜𝒜𝒜𝒜𝒜']) {
    const pieces = wrapPieces(text)
    assert.equal(pieces.join(''), text)
    for (const piece of pieces) assert.ok(Array.from(piece).length <= 12, piece)
    // No piece starts with half of a surrogate pair.
    for (const piece of pieces) assert.ok(!/^[\uDC00-\uDFFF]/.test(piece), piece)
  }
})

test('sizes and durations', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(812), '812 B')
  assert.equal(formatBytes(12_345), '12.3 kB')
  assert.equal(formatBytes(123_456), '123 kB')
  assert.equal(formatBytes(999_999), '1.0 MB')
  assert.equal(formatBytes(1_400_000), '1.4 MB')
  assert.equal(formatBytes(-1), '—')
  assert.equal(formatMs(0.42), '0.42 ms')
  assert.equal(formatMs(4.25), '4.3 ms')
  assert.equal(formatMs(120.4), '120 ms')
  assert.equal(formatMs(1234), '1.23 s')
  assert.equal(formatMs(125_000), '2.1 min')
  assert.equal(formatMs(-1), '—')
  const ru = stringsFor('ru').units
  assert.equal(formatBytes(12_345, ru, 'ru'), '12,3 кБ')
  assert.equal(formatMs(1234, ru, 'ru'), '1,23 с')
  assert.equal(formatMs(1234, ru, 'ru-RU'), '1,23 с')
  assert.equal(count(12345, 'de-DE'), '12,345')
  assert.equal(clockTime(Date.UTC(2026, 10, 15, 9, 41, 12, 7)), '09:41:12.007')
  assert.equal(dateTime(Date.UTC(2026, 10, 15, 9, 41, 12)), '2026-11-15 09:41:12 UTC')
  assert.equal(tickStep(1000), 200)
  assert.equal(tickStep(4200), 1000)
  assert.equal(tickStep(30), 5)
})

test('highlighting: JSON keys and values', () => {
  const tokens = tokenize('{"a": 1, "b": [true, null, "x"]}', 'json')
  assert.deepEqual(
    tokens.filter(([kind]) => kind !== 'punct' && kind !== 'plain'),
    [
      ['key', '"a"'],
      ['number', '1'],
      ['key', '"b"'],
      ['literal', 'true'],
      ['literal', 'null'],
      ['string', '"x"']
    ]
  )
})

test('highlighting: JavaScript comments, strings, keywords and numbers', () => {
  const tokens = tokenize('// hi\nconst a = "x" + 42 /* c */\nlet s = `t${1}`', 'js')
  const kinds = tokens.map(([k]) => k)
  assert.ok(kinds.includes('comment') && kinds.includes('keyword') && kinds.includes('string') && kinds.includes('number'))
  assert.equal(tokens.map(([, t]) => t).join(''), '// hi\nconst a = "x" + 42 /* c */\nlet s = `t${1}`', 'text is kept exactly')
  // An unterminated string stops at the end of its line.
  const broken = tokenize('a = "open\nb = 1', 'js')
  assert.ok(broken.some(([k, t]) => k === 'number' && t === '1'))
})

test('highlighting: CSS and HTML', () => {
  const css = tokenize('@media (x) { .a { color: #fff; margin: 0 } }', 'css')
  assert.ok(css.some(([k, t]) => k === 'at' && t === '@media'))
  assert.ok(css.some(([k, t]) => k === 'prop' && t === 'color'))
  assert.ok(css.some(([k, t]) => k === 'number' && t === '#fff'))
  const html = tokenize('<!-- c --><a href="x">t</a><script>let v = 1</script>', 'html')
  assert.ok(html.some(([k]) => k === 'comment'))
  assert.ok(html.some(([k, t]) => k === 'attr' && t === 'href'))
  assert.ok(html.some(([k, t]) => k === 'string' && t === '"x"'))
  assert.ok(html.some(([k, t]) => k === 'keyword' && t === 'let'), 'script bodies are highlighted as JavaScript')
  assert.equal(html.map(([, t]) => t).join(''), '<!-- c --><a href="x">t</a><script>let v = 1</script>')
})

test('lines split across tokens', () => {
  const lines = splitLines([
    ['string', 'a\nb'],
    ['plain', 'c\n']
  ])
  assert.deepEqual(lines, [[['string', 'a']], [['string', 'b'], ['plain', 'c']], []])
})

test('both languages have every string', () => {
  const en = stringsFor('en', true)
  const ru = stringsFor('ru-RU', true)
  assert.notEqual(en, ru)
  const keys = (o: object): string[] =>
    Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v).map((s) => `${k}.${s}`) : [k]))
  assert.deepEqual(keys(ru).sort(), keys(en).sort())
  assert.equal(stringsFor(undefined, true), stringsFor('en', true))
  assert.equal(en.requests(1), '1 request')
  assert.equal(ru.requests(1), '1 запрос')
  assert.equal(ru.requests(3), '3 запроса')
  assert.equal(ru.requests(11), '11 запросов')
  assert.equal(ru.requests(21), '21 запрос')
})

test('Server-Timing, Cookie and Set-Cookie headers', () => {
  assert.deepEqual(parseServerTiming('db;dur=53.2;desc="Database, primary", cache;desc=hit, app;dur=47'), [
    { name: 'db', duration: 53.2, description: 'Database, primary' },
    { name: 'cache', duration: -1, description: 'hit' },
    { name: 'app', duration: 47, description: '' }
  ])
  assert.deepEqual(parseServerTiming(''), [])
  assert.deepEqual(parseCookieHeader('a=1; b=x=y;  c'), [
    { name: 'a', value: '1' },
    { name: 'b', value: 'x=y' },
    { name: '', value: 'c' }
  ])
  assert.deepEqual(parseSetCookie('sid=abc; Path=/; Domain=.example.com; HttpOnly; Secure; SameSite=Lax; Max-Age=60'), {
    name: 'sid',
    value: 'abc',
    path: '/',
    domain: '.example.com',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    expires: 'max-age=60'
  })
  const fromHeaders = responseCookies([], [{ name: 'Set-Cookie', value: 'a=1; Path=/\nb=2; Secure' }])
  assert.deepEqual(fromHeaders.map((c) => c.name), ['a', 'b'])
  assert.deepEqual(requestCookies([], [{ name: 'cookie', value: 'x=1; y=2' }]).map((c) => c.value), ['1', '2'])
  assert.deepEqual(requestCookies([{ name: 'k', value: 'v' }], [{ name: 'cookie', value: 'x=1' }]).map((c) => c.name), ['k'])
})

test('hex dump and JSON previews', () => {
  const bytes = new Uint8Array(20).map((_, i) => (i === 0 ? 0x41 : i))
  const lines = hexDump(bytes).split('\n')
  assert.equal(lines.length, 2)
  assert.equal(lines[0], '00000000  41 01 02 03 04 05 06 07  08 09 0a 0b 0c 0d 0e 0f  A...............')
  assert.ok(lines[1].startsWith('00000010  10 11 12 13 '))
  assert.equal(hexDump(new Uint8Array(100), 32).split('\n').length, 2)
  assert.equal(preview({ id: 42, name: 'Demo', tags: ['a'], meta: { x: 1 } }), '{id: 42, name: "Demo", tags: Array(1), meta: {…}}')
  assert.equal(preview([1, 2, 3]), 'Array(3)')
  assert.ok(preview({ description: 'x'.repeat(100), more: 1, other: 2, again: 3, fifth: 'abcdefghijklmnopqrstuvwxyz' }).endsWith('…}'))
})

/** Every string of a table, by its path. */
function leaves(table: object, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(table)) {
    if (typeof value === 'string') out.set(prefix + key, value)
    else if (value && typeof value === 'object') for (const [k, v] of leaves(value, `${prefix}${key}.`)) out.set(k, v)
  }
  return out
}

test('review 24: the Russian table has no English left but names that stay as they are', () => {
  const en = leaves(stringsFor('en', true))
  const ru = leaves(stringsFor('ru', true))
  // Protocol and technical names that read the same in both languages.
  const same = new Set([
    'scopes.url',
    'types.fetch',
    'types.js',
    'types.css',
    'types.ws',
    'types.wasm',
    'domContentLoaded',
    'columns.url',
    'cookie.httpOnly',
    'cookie.secure',
    'cookie.sameSite',
    'opcodes.9',
    'opcodes.10',
    'caches.service worker'
  ])
  const untranslated = [...en].filter(([key, value]) => ru.get(key) === value && !same.has(key) && /[a-z]{3}/.test(value)).map(([key]) => key)
  assert.deepEqual(untranslated, [])
  const s = stringsFor('ru', true)
  assert.equal(fill(s.load, { time: '1,31 с' }), 'Загрузка: 1,31 с')
  assert.equal(s.loadLabel, 'Загрузка')
  assert.equal(fill(s.recorded, { creator: 'Chrome 131.0.6778.86', date: '2026-11-15 09:41' }), 'Записано: Chrome 131.0.6778.86, 2026-11-15 09:41')
})

test('review 26: shortcut labels name ⌘ on a Mac and Ctrl everywhere else', () => {
  for (const locale of ['en', 'ru']) {
    const mac = leaves(stringsFor(locale, true))
    const other = leaves(stringsFor(locale, false))
    assert.ok(mac.get('filterHint')!.includes('⌘F') && mac.get('copyFailed')!.includes('⌘C'))
    assert.deepEqual([...other.values()].filter((v) => v.includes('⌘')), [], locale)
    assert.ok(other.get('filterHint')!.includes('Ctrl+F') && other.get('exportManual')!.includes('Ctrl+C') && other.get('selectHint')!.includes('Ctrl-'))
  }
  assert.equal(stringsFor('en', false).requests(2), '2 requests', 'plurals survive the copy')
})

test('review 27: no string promises that every secret is masked', () => {
  for (const locale of ['en', 'ru']) {
    for (const [key, value] of leaves(stringsFor(locale, true))) assert.ok(!/every secret|all secrets|все секреты/i.test(value), `${locale}.${key}`)
  }
  assert.ok(/known secret patterns/.test(stringsFor('en', true).saveSanitizedHint) && /review/.test(stringsFor('en', true).saveSanitizedHint))
})

test('review 5, 7: the page menu lists the titles of the dataset on screen, masked when masking is on', () => {
  const har = {
    log: {
      pages: [
        { id: 'page_1', title: 'https://app.example.com/?session=abc123def', startedDateTime: '2026-11-15T10:00:00.000Z' },
        { id: 'page_2', title: 'https://app.example.com/reset?token=SuperSecretToken9', startedDateTime: '2026-11-15T10:00:01.000Z' }
      ],
      entries: [
        { pageref: 'page_1', request: { method: 'GET', url: 'https://app.example.com/' }, response: { status: 200 } },
        { request: { method: 'GET', url: 'https://cdn.example.com/x.js' }, response: { status: 200 } }
      ]
    }
  }
  const plain = pageChoices(buildModel(har), 'Without a page')
  const masked = pageChoices(buildModel(maskRecording(har).har), 'Without a page')
  assert.deepEqual(plain.map((c) => c.value), ['=page_1', '=page_2', '-'])
  assert.deepEqual(masked.map((c) => c.value), ['=page_1', '=page_2', '-'], 'the same ids, so the selection carries over')
  assert.deepEqual(masked.map((c) => c.label), ['https://app.example.com/?session=[masked]', 'https://app.example.com/reset?token=[masked]', 'Without a page'])
})

test('review 18, 13: the Source view indents deep or 64-bit JSON without throwing or rounding', () => {
  const deep = `${'['.repeat(10_000)}1${']'.repeat(10_000)}`
  assert.equal(sourceText(deep, true), deep, 'too deep to indent: shown as it is')
  const ids = '{"id":1234567890123456789,"price":1.10,"tags":["a","b"],"nested":{"big":12345678901234567890}}'
  assert.equal(sourceText(ids, true), '{\n  "id": 1234567890123456789,\n  "price": 1.10,\n  "tags": [\n    "a",\n    "b"\n  ],\n  "nested": {\n    "big": 12345678901234567890\n  }\n}')
  // The tree keeps the literal of numbers a double would round.
  const value = parseJson(ids) as Record<string, unknown>
  assert.equal(String(value.id), '1234567890123456789')
  assert.equal(value.price, 1.1)
  assert.equal(preview(value), '{id: 1234567890123456789, price: 1.1, tags: Array(2), nested: {…}}')
})

test('review 19, 27: binary frames whose bytes are text are shown as text, other binary as bytes', () => {
  const text = frameText({ type: 'receive', time: 1, opcode: 2, data: encodeBase64(new TextEncoder().encode('{"ok":true}')) })
  assert.equal(text.text, '{"ok":true}')
  const binary = frameText({ type: 'receive', time: 1, opcode: 2, data: 'AAECAwQ=' })
  assert.equal(binary.text, null)
  assert.deepEqual(Array.from(binary.bytes!), [0, 1, 2, 3, 4])
  assert.equal(frameText({ type: 'send', time: 1, opcode: 1, data: 'hi' }).text, 'hi')
})
