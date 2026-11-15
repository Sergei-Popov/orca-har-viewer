// The request list: a virtualized grid (only the rows in view exist in the DOM), sortable columns
// that drop out by priority when the pane is narrow, and a waterfall with a time scale and the
// pages' DOMContentLoaded and load lines.

import { h } from '../dom'
import { number, tickStep } from '../format'
import type { Entry, Model, Page } from '../har/model'
import type { Sort, SortKey } from '../har/query'
import { ROW_HEIGHT } from '../styles'
import type { Ctx } from './common'

type Column = { key: SortKey; width: string; min: number; numeric?: boolean; drop: number }

const COLUMNS: Column[] = [
  { key: 'status', width: '58px', min: 58, drop: 9 },
  { key: 'method', width: '72px', min: 72, drop: 4 },
  { key: 'domain', width: 'minmax(90px, 1fr)', min: 90, drop: 3 },
  { key: 'path', width: 'minmax(150px, 2.4fr)', min: 150, drop: 99 },
  { key: 'type', width: '82px', min: 82, drop: 5 },
  { key: 'initiator', width: 'minmax(90px, 1fr)', min: 90, drop: 1 },
  { key: 'transfer', width: '114px', min: 114, numeric: true, drop: 6 },
  { key: 'size', width: '70px', min: 70, numeric: true, drop: 2 },
  { key: 'time', width: '66px', min: 66, numeric: true, drop: 8 },
  { key: 'waterfall', width: 'minmax(140px, 1.8fr)', min: 140, drop: 7 }
]

const OVERSCAN = 10

export type Scale = { start: number; span: number; marks: { at: number; kind: 'dcl' | 'load' }[] }

export type ListEvents = {
  select(index: number, how: 'only' | 'toggle' | 'range'): void
  sort(key: SortKey): void
  clearFilters(): void
}

/** The time range the waterfall spans, and where the page lines fall. */
export function waterfallScale(entries: Entry[], order: number[], pages: Page[], pageId: string | null): Scale {
  let start = Infinity
  let end = -Infinity
  const shownPages = new Set<string>()
  for (const index of order) {
    const entry = entries[index]
    if (!Number.isFinite(entry.start)) continue
    start = Math.min(start, entry.start)
    end = Math.max(end, entry.start + Math.max(0, entry.time))
    shownPages.add(entry.pageId)
  }
  const marks: Scale['marks'] = []
  if (!Number.isFinite(start)) return { start: 0, span: 0, marks }
  for (const page of pages) {
    if (!Number.isFinite(page.start) || (pageId !== null ? page.id !== pageId : !shownPages.has(page.id))) continue
    for (const [value, kind] of [
      [page.onContentLoad, 'dcl'],
      [page.onLoad, 'load']
    ] as const) {
      if (value < 0) continue
      const at = page.start + value
      if (at >= start) {
        end = Math.max(end, at)
        marks.push({ at, kind })
      }
    }
  }
  return { start, span: Math.max(1, end - start), marks }
}

export class RequestList {
  readonly root: HTMLElement
  private readonly head: HTMLElement
  private readonly viewport: HTMLElement
  private readonly sizer: HTMLElement
  private readonly empty: HTMLElement
  private model: Model | null = null
  private order: number[] = []
  private position = new Map<number, number>()
  private sort: Sort = null
  private scale: Scale = { start: 0, span: 0, marks: [] }
  private masked: Set<number> | undefined
  private columns: Column[] = COLUMNS
  private rows = new Map<number, HTMLElement>()
  private current: number | null = null
  private picked = new Set<number>()
  private frame = 0
  private width = 0
  private tickPercent = 10

  constructor(
    private readonly ctx: Ctx,
    private readonly events: ListEvents
  ) {
    this.head = h('div', { className: 'hv-head hv-grid', role: 'row' })
    this.sizer = h('div', { className: 'hv-sizer' })
    this.empty = h('div', { className: 'hv-empty', hidden: true })
    this.viewport = h('div', { className: 'hv-viewport', tabindex: 0, role: 'grid', 'aria-label': ctx.strings.col.requests }, this.sizer, this.empty)
    this.root = h('div', { className: 'hv-list' }, this.head, this.viewport)
    this.viewport.addEventListener('scroll', () => this.schedule())
    this.viewport.addEventListener('mousedown', (event) => {
      if (event.shiftKey) event.preventDefault()
    })
    this.viewport.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('.hv-row')
      if (!row) return
      const index = Number(row.dataset.index)
      this.viewport.focus({ preventScroll: true })
      this.events.select(index, event.shiftKey ? 'range' : event.metaKey || event.ctrlKey ? 'toggle' : 'only')
    })
    new ResizeObserver(() => {
      const width = this.root.clientWidth
      if (width !== this.width) {
        this.width = width
        this.layout()
      }
      this.schedule()
    }).observe(this.root)
  }

  get rowsInView(): number {
    return Math.max(1, Math.floor(this.viewport.clientHeight / ROW_HEIGHT) - 1)
  }

  focus(): void {
    this.viewport.focus({ preventScroll: true })
  }

  setData(model: Model, order: number[], sort: Sort, scale: Scale, masked: Set<number> | undefined): void {
    const modelChanged = model !== this.model
    this.model = model
    this.order = order
    this.position = new Map(order.map((index, pos) => [index, pos]))
    this.sort = sort
    this.scale = scale
    this.masked = masked
    if (modelChanged) this.width = 0
    this.sizer.style.height = `${order.length * ROW_HEIGHT}px`
    this.empty.hidden = order.length > 0
    if (!order.length) {
      const clear = h('button', { type: 'button', className: 'hv-btn' }, this.ctx.strings.clearFilters)
      clear.addEventListener('click', () => this.events.clearFilters())
      this.empty.replaceChildren(h('div', {}, model.entries.length ? this.ctx.strings.noMatches : this.ctx.strings.emptyHar), model.entries.length ? clear : '')
    }
    this.layout()
    this.clearRows()
    this.schedule()
  }

  setSelection(current: number | null, picked: Set<number>): void {
    this.current = current
    this.picked = picked
    for (const row of this.rows.values()) this.paintSelection(row)
  }

  /** Scrolls so the request's row is in view; false when the filters hide it. */
  reveal(index: number): boolean {
    const pos = this.position.get(index)
    if (pos === undefined) return false
    const top = pos * ROW_HEIGHT
    const view = this.viewport
    if (top < view.scrollTop) view.scrollTop = top
    else if (top + ROW_HEIGHT > view.scrollTop + view.clientHeight) view.scrollTop = top + ROW_HEIGHT - view.clientHeight
    return true
  }

  /** The request `delta` rows away from `index` in the current order. */
  step(index: number | null, delta: number): number | null {
    if (!this.order.length) return null
    let pos = index === null ? -1 : (this.position.get(index) ?? -1)
    if (pos < 0) pos = delta > 0 ? -1 : this.order.length
    const next = Math.max(0, Math.min(this.order.length - 1, pos + delta))
    return this.order[next]
  }

  get visibleOrder(): number[] {
    return this.order
  }

  // ── Columns and header ──

  private layout(): void {
    if (!this.model) return
    const width = this.root.clientWidth || 900
    let columns = COLUMNS.filter((c) => c.key !== 'initiator' || this.model?.hasInitiator)
    while (columns.reduce((sum, c) => sum + c.min, 0) > width && columns.length > 2) {
      const lowest = columns.reduce((a, b) => (b.drop < a.drop ? b : a))
      columns = columns.filter((c) => c !== lowest)
    }
    const changed = columns.length !== this.columns.length || columns.some((c, i) => c !== this.columns[i])
    this.columns = columns
    this.root.style.setProperty('--cols', columns.map((c) => c.width).join(' '))
    this.renderHead()
    if (changed) this.clearRows()
  }

  private renderHead(): void {
    const s = this.ctx.strings
    const cells = this.columns.map((column) => {
      const sorted = this.sort?.key === column.key ? this.sort.dir : 0
      const th = h(
        'button',
        {
          type: 'button',
          className: `hv-th${column.numeric ? ' hv-num' : ''}${column.key === 'waterfall' ? ' hv-wf' : ''}`,
          title: s.sortHint,
          role: 'columnheader',
          'aria-sort': sorted === 1 ? 'ascending' : sorted === -1 ? 'descending' : 'none'
        },
        column.key === 'waterfall' ? '' : s.columns[column.key],
        sorted ? h('span', { className: 'hv-arrow' }, sorted === 1 ? '▲' : '▼') : null
      )
      th.addEventListener('click', () => this.events.sort(column.key))
      if (column.key === 'waterfall') th.dataset.wf = '1'
      return th
    })
    this.head.replaceChildren(...cells)
    // The header ticks need the waterfall column's width, known after layout.
    requestAnimationFrame(() => this.renderTicks())
    this.head.style.paddingRight = `${this.viewport.offsetWidth - this.viewport.clientWidth}px`
  }

  private renderTicks(): void {
    const th = this.head.querySelector<HTMLElement>('[data-wf]')
    if (!th) return
    const span = this.scale.span
    const width = th.clientWidth
    if (!span || !width) {
      th.replaceChildren(this.ctx.strings.columns.waterfall)
      return
    }
    const step = tickStep(span, Math.max(2, Math.floor(width / 80)))
    this.tickPercent = (step / span) * 100
    this.root.style.setProperty('--tick', `${this.tickPercent}%`)
    const ticks: Node[] = []
    for (let t = 0, k = 0; t <= span + 0.0001; t += step, k++) {
      const left = (t / span) * 100
      if (left > 96 && k > 0) break
      ticks.push(h('span', { className: `hv-tick${k === 0 ? ' hv-first' : ''}`, style: `left:${k === 0 ? 4 : (left / 100) * width}px` }, k === 0 ? '0' : tickLabel(t, this.ctx)))
    }
    const sorted = this.sort?.key === 'waterfall' ? this.sort.dir : 0
    th.replaceChildren(...ticks)
    if (sorted) th.append(h('span', { className: 'hv-arrow', style: 'position:absolute;right:4px' }, sorted === 1 ? '▲' : '▼'))
    th.setAttribute('aria-label', this.ctx.strings.columns.waterfall)
  }

  // ── Rows ──

  private schedule(): void {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.renderRows()
    })
  }

  private clearRows(): void {
    for (const row of this.rows.values()) row.remove()
    this.rows.clear()
  }

  private renderRows(): void {
    if (!this.model) return
    const view = this.viewport
    this.head.style.paddingRight = `${view.offsetWidth - view.clientWidth}px`
    const first = Math.max(0, Math.floor(view.scrollTop / ROW_HEIGHT) - OVERSCAN)
    const last = Math.min(this.order.length - 1, Math.ceil((view.scrollTop + view.clientHeight) / ROW_HEIGHT) + OVERSCAN)
    for (const [pos, row] of this.rows) {
      if (pos < first || pos > last) {
        row.remove()
        this.rows.delete(pos)
      }
    }
    const fragment = document.createDocumentFragment()
    for (let pos = first; pos <= last; pos++) {
      if (this.rows.has(pos)) continue
      const row = this.renderRow(pos)
      this.rows.set(pos, row)
      fragment.append(row)
    }
    this.sizer.append(fragment)
  }

  private paintSelection(row: HTMLElement): void {
    const index = Number(row.dataset.index)
    row.classList.toggle('hv-current', index === this.current)
    row.classList.toggle('hv-picked', this.picked.has(index) && index !== this.current)
    row.setAttribute('aria-selected', String(index === this.current || this.picked.has(index)))
  }

  private renderRow(pos: number): HTMLElement {
    const entry = (this.model as Model).entries[this.order[pos]]
    const row = h('div', { className: `hv-row hv-grid${entry.isError ? ' hv-error' : ''}`, role: 'row', style: `top:${pos * ROW_HEIGHT}px` })
    row.dataset.index = String(entry.index)
    for (const column of this.columns) row.append(this.cell(entry, column))
    this.paintSelection(row)
    return row
  }

  private cell(entry: Entry, column: Column): HTMLElement {
    const s = this.ctx.strings
    const cls = `hv-cell${column.numeric ? ' hv-num' : ''}`
    switch (column.key) {
      case 'status':
        if (entry.failed) return h('div', { className: cls, title: entry.error || s.failed }, s.failed)
        return h('div', { className: `${cls}${entry.status >= 300 && entry.status < 400 ? ' hv-st-3' : ''}`, title: `${entry.status} ${entry.statusText}` }, String(entry.status))
      case 'method':
        return h('div', { className: cls }, entry.method)
      case 'domain':
        return h('div', { className: `${cls} hv-dim`, title: entry.host }, entry.host)
      case 'path': {
        const el = h('div', { className: cls, title: entry.url })
        if (this.masked?.has(entry.index)) el.append(h('span', { className: 'hv-shield', title: s.mask }))
        el.append(entry.path || entry.url)
        return el
      }
      case 'type':
        return h('div', { className: `${cls} hv-dim`, title: entry.mimeType }, s.types[entry.type])
      case 'initiator':
        return h('div', { className: `${cls} hv-dim`, title: entry.initiatorUrl || entry.initiatorType }, entry.initiator)
      case 'transfer': {
        const text = entry.cache ? (s.caches[entry.cache] ?? entry.cache) : entry.transferSize >= 0 ? this.ctx.bytes(entry.transferSize) : '—'
        return h('div', { className: `${cls}${entry.cache ? ' hv-dim' : ''}` }, text)
      }
      case 'size':
        return h('div', { className: cls }, entry.resourceSize >= 0 ? this.ctx.bytes(entry.resourceSize) : '—')
      case 'time':
        return h('div', { className: cls }, entry.failed && entry.time <= 0 ? '—' : this.ctx.ms(entry.time))
      case 'waterfall':
        return this.waterfallCell(entry)
    }
  }

  private waterfallCell(entry: Entry): HTMLElement {
    const cell = h('div', { className: 'hv-cell hv-wfcell' }, h('div', { className: 'hv-wf-grid' }))
    const { start, span, marks } = this.scale
    for (const mark of marks) {
      cell.append(h('i', { className: `hv-mark hv-${mark.kind}`, style: `left:${((mark.at - start) / span) * 100}%` }))
    }
    if (!span || !Number.isFinite(entry.start)) return cell
    const left = ((entry.start - start) / span) * 100
    const width = (Math.max(0, entry.time) / span) * 100
    const bar = h('div', { className: 'hv-bar-wf', style: `left:${left}%;width:${width}%` })
    const t = entry.timings
    const setup = [t.blocked, t.dns, t.connect, t.ssl, t.send].reduce((sum, v) => sum + Math.max(0, v), 0)
    const wait = Math.max(0, t.wait)
    const receive = Math.max(0, t.receive)
    const known = setup + wait + receive
    if (entry.failed) bar.append(h('i', { className: 'hv-seg-fail', style: 'flex:1' }))
    else if (entry.cache && known === 0) bar.append(h('i', { className: 'hv-seg-cache', style: 'flex:1' }))
    else if (known <= 0) bar.append(h('i', { className: 'hv-seg-receive', style: 'flex:1' }))
    else {
      if (setup) bar.append(h('i', { className: 'hv-seg-setup', style: `flex:${setup}` }))
      if (wait) bar.append(h('i', { className: 'hv-seg-wait', style: `flex:${wait}` }))
      if (receive) bar.append(h('i', { className: 'hv-seg-receive', style: `flex:${receive}` }))
    }
    bar.title = `${this.ctx.ms(entry.time)} · ${this.ctx.strings.phases.wait}: ${this.ctx.ms(wait)}`
    cell.append(bar)
    return cell
  }
}

/** "250 ms", "1.5 s", "2 min": ticks fall on round values, so no trailing zeros. */
function tickLabel(ms: number, ctx: Ctx): string {
  const u = ctx.strings.units
  const trim = (value: number) => number(value, value < 10 ? 2 : 1, ctx.locale).replace(/[.,]?0+$/, '')
  if (ms < 1000) return `${trim(ms)} ${u.ms}`
  if (ms < 60_000) return `${trim(ms / 1000)} ${u.s}`
  return `${trim(ms / 60_000)} ${u.min}`
}
