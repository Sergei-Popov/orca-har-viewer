// The right pane when no request is selected: what was recorded, the totals, requests by type and
// status, a per-domain breakdown that filters the list, and the slowest, largest and failed requests.

import { append, h } from '../dom'
import { dateTime } from '../format'
import { RESOURCE_TYPES } from '../har/classify'
import type { Entry, Model } from '../har/model'
import type { DomainStats, Summary } from '../har/summary'
import { fill } from '../i18n'
import type { Ctx } from './common'

export type OverviewEvents = {
  select(index: number): void
  domain(host: string | null): void
}

export type OverviewInput = {
  model: Model
  indexes: number[]
  summary: Summary
  /** Per-domain numbers with every filter but the domain one, so other domains stay listed. */
  domains: DomainStats[]
  activeDomain: string | null
}

const STATUS_ORDER = ['1xx', '2xx', '3xx', '4xx', '5xx', 'failed']

export function overview(ctx: Ctx, input: OverviewInput, events: OverviewEvents): HTMLElement {
  const s = ctx.strings
  const { model, summary } = input
  const root = h('div', { className: 'hv-overview' })

  const titled = model.pages.length === 1 ? model.pages[0].title : s.overview
  const recorded = [model.creator ? fill(s.recordedBy, { creator: model.creator }) : '', model.start ? fill(s.recordedOn, { date: dateTime(model.start) }) : '']
    .filter(Boolean)
    .join(' ')
  root.append(
    h('div', { className: 'hv-ov-head' }, h('h2', { title: titled }, titled), recorded ? h('span', { className: 'hv-muted' }, recorded) : null),
    h('div', { className: 'hv-muted' }, s.overviewHint)
  )

  const cards = h('div', { className: 'hv-cards' })
  const card = (value: string, label: string, className = '') => cards.append(h('div', { className: `hv-card ${className}` }, h('b', {}, value), h('span', {}, label)))
  card(summary.count === summary.total ? ctx.count(summary.count) : `${ctx.count(summary.count)} / ${ctx.count(summary.total)}`, s.col.requests)
  card(ctx.bytes(summary.transferred), s.columns.transfer)
  card(ctx.bytes(summary.resources), s.columns.size)
  card(ctx.ms(summary.finish), s.finishLabel)
  if (summary.page && summary.page.onContentLoad >= 0) card(ctx.ms(summary.page.onContentLoad), 'DOMContentLoaded')
  if (summary.page && summary.page.onLoad >= 0) card(ctx.ms(summary.page.onLoad), 'Load')
  card(ctx.count(summary.errors), s.col.errors, summary.errors ? 'hv-err' : '')
  root.append(cards)

  // Requests by type and by status.
  const byType = new Map<string, number>()
  for (const index of input.indexes) {
    const type = model.entries[index].type
    byType.set(type, (byType.get(type) ?? 0) + 1)
  }
  const typeRows = RESOURCE_TYPES.filter((t) => byType.get(t)).map((t): [string, number, boolean] => [s.types[t], byType.get(t) ?? 0, false])
  const statusRows = STATUS_ORDER.filter((k) => summary.statuses[k]).map((k): [string, number, boolean] => [k === 'failed' ? s.failed : k, summary.statuses[k], k === '4xx' || k === '5xx' || k === 'failed'])
  const twoUp = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px' })
  if (typeRows.length) twoUp.append(block(s.byType, bars(typeRows, ctx)))
  if (statusRows.length) twoUp.append(block(s.byStatus, bars(statusRows, ctx)))
  root.append(twoUp)

  // Domains.
  if (input.domains.length) {
    const table = h(
      'table',
      { className: 'hv-table' },
      h('tr', {}, h('th', {}, s.columns.domain), h('th', { className: 'hv-num' }, s.col.requests), h('th', { className: 'hv-num' }, s.col.transferred), h('th', { className: 'hv-num' }, s.col.time), h('th', { className: 'hv-num' }, s.col.errors))
    )
    for (const domain of input.domains.slice(0, 100)) {
      const active = domain.host === input.activeDomain
      const tr = h(
        'tr',
        { className: `hv-clickable${active ? ' hv-active' : ''}`, title: s.domainFilterHint, tabindex: 0 },
        h('td', { className: 'hv-wrapcell' }, domain.host || '—'),
        h('td', { className: 'hv-num' }, ctx.count(domain.count)),
        h('td', { className: 'hv-num' }, ctx.bytes(domain.transferred)),
        h('td', { className: 'hv-num' }, ctx.ms(domain.time)),
        h('td', { className: `hv-num${domain.errors ? ' hv-err' : ''}` }, domain.errors ? ctx.count(domain.errors) : '')
      )
      const pick = () => events.domain(active ? null : domain.host)
      tr.addEventListener('click', pick)
      tr.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          pick()
        }
      })
      table.append(tr)
    }
    root.append(block(`${s.domainsTitle} · ${s.domains(input.domains.length)}`, table, 'hv-ov-domains'))
  }

  // Slowest, largest, errors.
  const lists = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px' })
  if (summary.slowest.length) lists.append(block(s.slowestTitle, links(summary.slowest, (e) => ctx.ms(e.time), events)))
  if (summary.largest.length) lists.append(block(s.largestTitle, links(summary.largest, (e) => ctx.bytes(Math.max(e.resourceSize, e.transferSize)), events)))
  root.append(lists)
  const errors = input.indexes.map((i) => model.entries[i]).filter((e) => e.isError)
  if (errors.length) root.append(block(`${s.errorsTitle} · ${ctx.count(errors.length)}`, links(errors.slice(0, 30), (e) => (e.failed ? e.error || s.failed : `${e.status} ${e.statusText}`), events, true)))

  // Pages.
  if (model.pages.length > 1) {
    const counts = new Map<string, number>()
    for (const entry of model.entries) counts.set(entry.pageId, (counts.get(entry.pageId) ?? 0) + 1)
    const table = h('table', { className: 'hv-table' }, h('tr', {}, h('th', {}, s.page), h('th', { className: 'hv-num' }, s.col.requests), h('th', { className: 'hv-num' }, 'DOMContentLoaded'), h('th', { className: 'hv-num' }, 'Load')))
    for (const page of model.pages) {
      table.append(
        h(
          'tr',
          {},
          h('td', { className: 'hv-wrapcell' }, page.title),
          h('td', { className: 'hv-num' }, ctx.count(counts.get(page.id) ?? 0)),
          h('td', { className: 'hv-num' }, page.onContentLoad >= 0 ? ctx.ms(page.onContentLoad) : '—'),
          h('td', { className: 'hv-num' }, page.onLoad >= 0 ? ctx.ms(page.onLoad) : '—')
        )
      )
    }
    root.append(block(s.pageTimings, table))
  }
  return root
}

function block(title: string, body: Node, className = ''): HTMLElement {
  return h('div', { className: `hv-ov ${className}` }, h('h3', {}, title), body)
}

function bars(rows: [string, number, boolean][], ctx: Ctx): HTMLElement {
  const max = Math.max(1, ...rows.map((r) => r[1]))
  const grid = h('div', { className: 'hv-bars' })
  for (const [label, value, error] of rows) {
    append(
      grid,
      h('span', {}, label),
      h('div', {}, h('div', { className: `hv-fill${error ? ' hv-err' : ''}`, style: `width:${(value / max) * 100}%` })),
      h('span', { className: 'hv-muted', style: 'text-align:right' }, ctx.count(value))
    )
  }
  return grid
}

function links(entries: Entry[], detail: (e: Entry) => string, events: OverviewEvents, error = false): HTMLElement {
  const list = h('div', { style: 'display:flex;flex-direction:column;gap:3px' })
  for (const entry of entries) {
    const link = h('button', { type: 'button', className: `hv-link${error ? ' hv-err' : ''}`, title: entry.url, style: 'max-width:65%' }, entry.name || entry.url)
    link.addEventListener('click', () => events.select(entry.index))
    list.append(h('div', { style: 'display:flex;gap:6px;align-items:baseline;min-width:0' }, link, h('span', { className: 'hv-muted', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, detail(entry))))
  }
  return list
}
