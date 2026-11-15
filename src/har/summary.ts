// The numbers of the summary strip and the overview: totals, page timings, slowest and largest
// requests, and a per-domain breakdown.

import type { Entry, Model, Page } from './model'

export type DomainStats = { host: string; count: number; transferred: number; resources: number; time: number; errors: number }

export type Summary = {
  count: number
  total: number
  transferred: number
  resources: number
  /** From the first request's start to the last one's end, ms. */
  finish: number
  /** Page timings of the page in view (the filtered page, or the first one). */
  page: Page | null
  errors: number
  slowest: Entry[]
  largest: Entry[]
  domains: DomainStats[]
  /** Status classes: '2xx', '3xx', '4xx', '5xx', 'failed'. */
  statuses: Record<string, number>
}

const TOP = 5

export function summarize(model: Model, indexes: number[], pageId: string | null): Summary {
  let transferred = 0
  let resources = 0
  let start = Infinity
  let end = -Infinity
  let errors = 0
  const domains = new Map<string, DomainStats>()
  const statuses: Record<string, number> = {}
  const entries: Entry[] = []
  for (const index of indexes) {
    const entry = model.entries[index]
    entries.push(entry)
    if (entry.transferSize > 0) transferred += entry.transferSize
    if (entry.resourceSize > 0) resources += entry.resourceSize
    if (Number.isFinite(entry.start)) {
      start = Math.min(start, entry.start)
      end = Math.max(end, entry.start + entry.time)
    }
    if (entry.isError) errors++
    const status = entry.failed ? 'failed' : entry.status ? `${Math.floor(entry.status / 100)}xx` : 'failed'
    statuses[status] = (statuses[status] ?? 0) + 1
    let domain = domains.get(entry.host)
    if (!domain) {
      domain = { host: entry.host, count: 0, transferred: 0, resources: 0, time: 0, errors: 0 }
      domains.set(entry.host, domain)
    }
    domain.count++
    domain.transferred += Math.max(0, entry.transferSize)
    domain.resources += Math.max(0, entry.resourceSize)
    domain.time += entry.time
    if (entry.isError) domain.errors++
  }
  const page =
    pageId !== null && pageId !== '' ? (model.pages.find((p) => p.id === pageId) ?? null) : (model.pages[0] ?? null)
  return {
    count: indexes.length,
    total: model.entries.length,
    transferred,
    resources,
    finish: Number.isFinite(start) ? end - start : 0,
    page,
    errors,
    slowest: top(entries, (e) => e.time),
    largest: top(entries, (e) => Math.max(e.resourceSize, e.transferSize)),
    domains: [...domains.values()].sort((a, b) => b.count - a.count || b.transferred - a.transferred || a.host.localeCompare(b.host)),
    statuses
  }
}

function top(entries: Entry[], score: (e: Entry) => number): Entry[] {
  return entries
    .filter((e) => score(e) > 0)
    .sort((a, b) => score(b) - score(a) || a.index - b.index)
    .slice(0, TOP)
}
