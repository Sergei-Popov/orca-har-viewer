import { assert, test } from 'orca/testing'
import { clockTime, count, dateTime, formatBytes, formatMs, tickStep } from './format'
import { splitLines, tokenize } from './highlight'
import { parseCookieHeader, parseServerTiming, parseSetCookie, requestCookies, responseCookies } from './har/headers'
import { stringsFor } from './i18n'
import { hexDump, preview } from './ui/viewers'

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
  const en = stringsFor('en')
  const ru = stringsFor('ru-RU')
  assert.notEqual(en, ru)
  const keys = (o: object): string[] =>
    Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v).map((s) => `${k}.${s}`) : [k]))
  assert.deepEqual(keys(ru).sort(), keys(en).sort())
  assert.equal(stringsFor(undefined), en)
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
