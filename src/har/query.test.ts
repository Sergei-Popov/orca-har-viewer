import { assert, test } from 'orca/testing'
import { demoHar } from '../fixtures/demo'
import { buildModel } from './model'
import { Haystacks, emptyFilter, filterEntries, parseDuration, parseQuery, parseSize, sortIndexes, type FilterState } from './query'
import { summarize } from './summary'

const model = buildModel(demoHar())
const run = (patch: Partial<FilterState>) => {
  const filter = { ...emptyFilter(), ...patch }
  return filterEntries(model, filter, new Haystacks()).map((i) => model.entries[i])
}

test('query language: words, negation, quotes, properties and regex', () => {
  const terms = parseQuery('api -cdn "two words" status:404 /orders\\/\\d+/ domain:*.example.com')
  assert.deepEqual(
    terms.map((t) => [t.kind, t.negate]),
    [
      ['text', false],
      ['text', true],
      ['text', false],
      ['prop', false],
      ['regex', false],
      ['prop', false]
    ]
  )
  assert.equal(parseSize('10k'), 10240)
  assert.equal(parseSize('1.5M'), 1.5 * 1024 * 1024)
  assert.ok(Number.isNaN(parseSize('big')))
  assert.equal(parseDuration('1.5s'), 1500)
  assert.equal(parseDuration('250'), 250)
})

test('text filter by URL; scope widens to headers and bodies', () => {
  assert.ok(run({ text: 'metrics' }).every((e) => e.url.includes('metrics')))
  assert.equal(run({ text: 'report_timeout' }).length, 0, 'body text is not searched in the URL scope')
  assert.equal(run({ text: 'report_timeout', scope: 'all' }).length, 1)
  assert.equal(run({ text: 'server-timing' }).length, 0)
  assert.ok(run({ text: 'server-timing', scope: 'headers' }).length > 3)
  assert.equal(run({ text: 'metrics.tick', scope: 'all' })[0]?.type, 'ws', 'WebSocket frames count as bodies')
  assert.ok(run({ text: 'api -orders' }).every((e) => e.url.includes('api') && !e.url.includes('orders')))
  assert.equal(run({ text: '/orders\\/482\\d\\d\\/refund/' }).length, 1)
})

test('property filters', () => {
  assert.deepEqual(run({ text: 'status:404' }).map((e) => e.status), [404])
  assert.ok(run({ text: 'status:5xx' }).every((e) => e.status >= 500))
  assert.equal(run({ text: 'status:failed' }).length, 1)
  assert.ok(run({ text: 'method:post' }).every((e) => e.method === 'POST'))
  assert.ok(run({ text: 'domain:*.example.net' }).every((e) => e.host.endsWith('.example.net')))
  assert.ok(run({ text: 'larger-than:100k' }).every((e) => Math.max(e.transferSize, e.resourceSize) > 100 * 1024))
  assert.ok(run({ text: 'slower-than:1s' }).every((e) => e.time > 1000))
  assert.ok(run({ text: 'is:cached' }).every((e) => e.cache))
  assert.ok(run({ text: 'has-response-header:set-cookie' }).length >= 1)
  assert.ok(run({ text: 'mime:json -status:2xx' }).every((e) => e.mimeType.includes('json') && (e.status < 200 || e.status >= 300)))
})

test('type chips, errors only, page and domain', () => {
  assert.ok(run({ types: new Set(['fetch']) }).every((e) => e.type === 'fetch'))
  assert.ok(run({ types: new Set(['js', 'css']) }).every((e) => e.type === 'js' || e.type === 'css'))
  const errors = run({ errorsOnly: true })
  assert.deepEqual(errors.map((e) => (e.failed ? 'failed' : e.status)).sort(), ['failed', 404, 409, 500].sort())
  assert.ok(run({ page: 'page_2' }).every((e) => e.pageId === 'page_2'))
  assert.ok(run({ page: 'page_2' }).length >= 5)
  assert.ok(run({ domain: 'cdn.example.net' }).every((e) => e.host === 'cdn.example.net'))
})

test('sorting is stable and every column sorts', () => {
  const all = model.entries.map((e) => e.index)
  const bySize = sortIndexes([...all], model.entries, { key: 'size', dir: -1 })
  for (let i = 1; i < bySize.length; i++) assert.ok(model.entries[bySize[i - 1]].resourceSize >= model.entries[bySize[i]].resourceSize)
  const byStatus = sortIndexes([...all], model.entries, { key: 'status', dir: 1 })
  assert.ok(model.entries[byStatus[0]].failed, 'failed sorts before every status')
  for (const key of ['method', 'domain', 'path', 'type', 'initiator', 'transfer', 'time', 'waterfall'] as const) {
    assert.equal(sortIndexes([...all], model.entries, { key, dir: 1 }).length, all.length)
  }
  assert.deepEqual(sortIndexes([3, 1, 2], model.entries, null), [1, 2, 3])
})

test('summary: totals, page timings, slowest, largest and domains', () => {
  const all = model.entries.map((e) => e.index)
  const s = summarize(model, all, null)
  assert.equal(s.count, model.entries.length)
  assert.equal(s.errors, 4)
  assert.ok(s.transferred > 300_000)
  assert.ok(s.resources > s.transferred / 2)
  assert.equal(s.page?.id, 'page_1')
  assert.ok(s.slowest[0].url.includes('/reports/export'))
  assert.ok(s.largest[0].url.includes('onboarding.mp4'))
  assert.equal(s.domains[0].host, 'app.example.com')
  assert.equal(s.domains.reduce((sum, d) => sum + d.count, 0), s.count)
  assert.equal(s.statuses.failed, 1)
  const page2 = summarize(model, filterEntries(model, { ...emptyFilter(), page: 'page_2' }, new Haystacks()), 'page_2')
  assert.equal(page2.page?.id, 'page_2')
  assert.ok(page2.finish > 1000 && page2.finish < 3000)
})
