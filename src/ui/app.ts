// The viewer: toolbar with filters, the request list beside the details (or the overview), notices
// about damaged files and masking, and the summary strip. Holds the filter, sort and selection,
// and swaps the HAR for its masked copy while "Mask secrets" is on.

import { h, svg } from '../dom'
import { count, formatBytes, formatMs } from '../format'
import type { SideFiles } from '../har/body'
import { RESOURCE_TYPES, type ResourceType } from '../har/classify'
import { maskedHarBytes, maskedHarZipSteps, maskingWeight, maskRecording, maskSteps, runSteps, runStepsAsync, type Masked } from '../har/masked'
import { buildModel } from '../har/model'
import { emptyFilter, filterEntries, Haystacks, sortIndexes, type FilterState, type Scope, type Sort, type SortKey } from '../har/query'
import type { ReadIssue } from '../har/read'
import { summarize } from '../har/summary'
import type { Har } from '../har/types'
import { fill, type Strings } from '../i18n'
import { icon } from '../icons'
import { pageChoices } from './choices'
import { typingInto, type Ctx, type Dataset, type SaveAs } from './common'
import { DetailsPane } from './details'
import { ExportPopover } from './export'
import { RequestList, waterfallScale } from './list'
import { overview } from './overview'

/** A HAR as opened: from a .har, or from a .har.zip with its body files. */
/** `compact`: the .har was minified, so its sanitized copy is too. */
export type Recording = { har: Har; issue?: ReadIssue; files?: SideFiles; zip: boolean; compact?: boolean }

type View = Dataset & { haystacks: Haystacks }

/** What Orca hands a plugin to save; over this the bridge refuses the data. */
const SAVE_LIMIT = 64 * 1024 * 1024
const SEARCH_DELAY = 150
/**
 * Text (bytes) up to which masking, or building the sanitized copy, runs at once. Past it the
 * work runs in slices with progress, as the save dialog must open within Orca's few-second
 * gesture window and a busy page cannot paint.
 */
const QUICK = 16 * 1024 * 1024

type MaskedView = View & { result: Masked }
type Copy = { data: Uint8Array; suggestedName: string; mimeType: string }

export class HarApp {
  readonly root = h('div', { className: 'hv-app' })
  private readonly ctx: Ctx
  private readonly s: Strings
  private recording: Recording | null = null
  private plain: View | null = null
  private masked: MaskedView | null = null
  private masking = false
  /** Bumped by every `open`, so work started for an earlier file is dropped. */
  private generation = 0
  private job: Promise<MaskedView | null> | null = null
  private progress: string | null = null
  private readonly progressText = h('span')
  /** A sanitized copy built ahead of the click that saves it. */
  private prepared: Copy | null = null
  private preparing = false
  private filter: FilterState = emptyFilter()
  private sort: Sort = null
  private current: number | null = null
  private picked = new Set<number>()
  private anchor: number | null = null
  private order: number[] = []
  private detailsKey = ''
  private built = false
  private toastTimer = 0
  private searchTimer = 0

  private readonly list: RequestList
  private readonly details: DetailsPane
  private readonly exporter: ExportPopover
  private readonly toastEl = h('div', { className: 'hv-toast', role: 'status', 'aria-live': 'polite' })
  private readonly search = h('input', { type: 'search', spellcheck: 'false', autocomplete: 'off' })
  private readonly scope = h('select', { className: 'hv-select' })
  private readonly errorsButton = h('button', { type: 'button', className: 'hv-btn hv-errors', 'aria-pressed': 'false' })
  private readonly pageSelect = h('select', { className: 'hv-select' })
  private readonly domainSelect = h('select', { className: 'hv-select' })
  private readonly maskButton = h('button', { type: 'button', className: 'hv-btn hv-mask', 'aria-pressed': 'false' })
  private readonly exportButton = h('button', { type: 'button', className: 'hv-btn' })
  private readonly saveButton = h('button', { type: 'button', className: 'hv-btn' })
  private readonly chips = h('div', { className: 'hv-chips', role: 'toolbar' })
  private readonly notices = h('div')
  private readonly main = h('div', { className: 'hv-main' })
  private readonly split = h('div', { className: 'hv-split', role: 'separator', tabindex: 0, 'aria-orientation': 'vertical' })
  private readonly summaryEl = h('div', { className: 'hv-summary', role: 'status' })

  constructor(options: { strings: Strings; locale: string; saveAs?: SaveAs }) {
    const { strings, locale } = options
    this.s = strings
    this.ctx = {
      strings,
      locale,
      bytes: (n) => formatBytes(n, strings.units, locale),
      ms: (n) => formatMs(n, strings.units, locale),
      count: (n) => count(n, locale),
      toast: (text) => this.toast(text),
      saveAs: options.saveAs
    }
    this.list = new RequestList(this.ctx, {
      select: (index, how) => this.select(index, how),
      sort: (key) => this.toggleSort(key),
      clearFilters: () => this.clearFilters()
    })
    this.details = new DetailsPane(this.ctx, {
      select: (index) => this.select(index, 'only', true),
      close: () => this.closeDetails()
    })
    this.exporter = new ExportPopover(this.ctx)
    // On the document: keys pressed before anything in the viewer has focus count too.
    document.addEventListener('keydown', (event) => this.onKey(event))
  }

  // ── States ──

  showLoading(): void {
    this.built = false
    this.root.replaceChildren(h('div', { className: 'hv-state' }, h('div', { className: 'hv-spinner' }), h('p', {}, this.s.loading)))
  }

  showError(title: string, message: string, detail?: string): void {
    this.built = false
    this.recording = null
    this.root.replaceChildren(
      h(
        'div',
        { className: 'hv-state', role: 'alert' },
        h('div', { style: 'color:var(--err)' }, svg(icon('error'))),
        h('h2', {}, title),
        h('p', {}, message),
        detail ? h('p', { className: 'hv-mono' }, detail) : null
      )
    )
  }

  /** Shows a recording; on a reload of the same file the filters, sort and selection stay. */
  open(recording: Recording): void {
    this.recording = recording
    this.plain = this.view(recording.har, recording.files)
    this.generation++
    this.masked = null
    this.job = null
    this.progress = null
    this.prepared = null
    this.preparing = false
    // Masking stays on across reloads: at once for a light file, else when the masked copy is ready.
    const remask = this.masking
    this.masking = remask && this.isLight() && !!this.maskNow()
    const model = this.plain.model
    if (this.current !== null && this.current >= model.entries.length) this.current = null
    this.picked = new Set([...this.picked].filter((i) => i < model.entries.length))
    if (this.filter.page !== null && this.filter.page !== '' && !model.pages.some((p) => p.id === this.filter.page)) this.filter.page = null
    if (this.filter.domain !== null && !model.domains.some((d) => d.host === this.filter.domain)) this.filter.domain = null
    this.detailsKey = ''
    if (!this.built) this.build()
    this.fillControls()
    this.refresh()
    if (remask && !this.masking) void this.setMasking(true)
  }

  private view(har: Har, files?: SideFiles): View {
    return { model: buildModel(har), files, haystacks: new Haystacks(files) }
  }

  private get data(): View {
    return (this.masking && this.masked) || (this.plain as View)
  }

  // ── Layout ──

  private build(): void {
    const s = this.s
    this.built = true
    this.search.placeholder = s.filter
    this.search.title = s.filterHint
    this.search.setAttribute('aria-label', s.filter)
    this.search.addEventListener('input', () => {
      clearTimeout(this.searchTimer)
      this.searchTimer = window.setTimeout(() => {
        this.filter.text = this.search.value
        this.refresh()
      }, SEARCH_DELAY)
    })
    this.scope.title = s.scopeHint
    this.scope.setAttribute('aria-label', s.scopeHint)
    for (const scope of ['url', 'headers', 'all'] as Scope[]) this.scope.append(h('option', { value: scope }, s.scopes[scope]))
    this.scope.addEventListener('change', () => {
      this.filter.scope = this.scope.value as Scope
      this.refresh()
    })
    this.errorsButton.replaceChildren(svg(icon('warning')), s.errorsOnly)
    this.errorsButton.title = s.errorsHint
    this.errorsButton.addEventListener('click', () => {
      this.filter.errorsOnly = !this.filter.errorsOnly
      this.refresh()
    })
    this.pageSelect.title = s.pageHint
    this.pageSelect.setAttribute('aria-label', s.pageHint)
    this.pageSelect.addEventListener('change', () => {
      const value = this.pageSelect.value
      this.filter.page = value === '*' ? null : value === '-' ? '' : value.slice(1)
      this.refresh()
    })
    this.domainSelect.title = s.domainHint
    this.domainSelect.setAttribute('aria-label', s.domainHint)
    this.domainSelect.addEventListener('change', () => {
      this.filter.domain = this.domainSelect.value === '*' ? null : this.domainSelect.value.slice(1)
      this.refresh()
    })
    this.maskButton.replaceChildren(svg(icon('shield')), h('span', { className: 'hv-label' }, s.mask))
    this.maskButton.title = `${s.mask}: ${s.maskHint}`
    this.maskButton.setAttribute('aria-label', s.mask)
    this.maskButton.addEventListener('click', () => void this.setMasking(!this.masking))
    this.exportButton.replaceChildren(svg(icon('agent')), h('span', { className: 'hv-label' }, s.export))
    this.exportButton.title = `${s.export}: ${s.exportHint}`
    this.exportButton.setAttribute('aria-label', s.export)
    this.exportButton.dataset.exportToggle = '1'
    this.exportButton.addEventListener('click', () => void this.toggleExport())
    this.saveButton.replaceChildren(svg(icon('save')), h('span', { className: 'hv-label' }, s.saveSanitized))
    this.saveButton.title = s.saveSanitizedHint
    this.saveButton.setAttribute('aria-label', s.saveSanitized)
    this.saveButton.addEventListener('click', () => this.saveSanitized())
    this.saveButton.hidden = !this.ctx.saveAs

    const searchBox = h('div', { className: 'hv-search' }, svg(icon('search')), this.search)
    const bar1 = h(
      'div',
      { className: 'hv-bar', role: 'toolbar' },
      searchBox,
      this.scope,
      this.errorsButton,
      this.pageSelect,
      this.domainSelect,
      h('span', { className: 'hv-spacer' }),
      this.maskButton,
      this.exportButton,
      this.saveButton
    )
    const bar2 = h('div', { className: 'hv-bar' }, this.chips)
    this.main.replaceChildren(this.list.root, this.split, this.details.root)
    this.setupSplit()
    this.root.replaceChildren(bar1, bar2, this.notices, this.main, this.summaryEl, this.exporter.root, this.toastEl)
  }

  private setupSplit(): void {
    const stacked = () => window.matchMedia('(max-width: 760px)').matches
    const setRatio = (ratio: number) => {
      const clamped = Math.max(0.2, Math.min(0.85, ratio))
      this.main.style.setProperty(stacked() ? '--list-h' : '--list', `${(clamped * 100).toFixed(1)}%`)
      this.split.setAttribute('aria-valuenow', String(Math.round(clamped * 100)))
    }
    this.split.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      this.split.setPointerCapture(event.pointerId)
      this.split.classList.add('hv-dragging')
      const move = (e: PointerEvent) => {
        const rect = this.main.getBoundingClientRect()
        setRatio(stacked() ? (e.clientY - rect.top) / rect.height : (e.clientX - rect.left) / rect.width)
      }
      const up = () => {
        this.split.classList.remove('hv-dragging')
        this.split.removeEventListener('pointermove', move)
        this.split.removeEventListener('pointerup', up)
        this.split.removeEventListener('pointercancel', up)
      }
      this.split.addEventListener('pointermove', move)
      this.split.addEventListener('pointerup', up)
      this.split.addEventListener('pointercancel', up)
    })
    this.split.addEventListener('keydown', (event) => {
      const keys: Record<string, number> = { ArrowLeft: -0.05, ArrowUp: -0.05, ArrowRight: 0.05, ArrowDown: 0.05 }
      if (!(event.key in keys)) return
      event.preventDefault()
      event.stopPropagation()
      const rect = this.main.getBoundingClientRect()
      const listRect = this.list.root.getBoundingClientRect()
      const now = stacked() ? listRect.height / rect.height : listRect.width / rect.width
      setRatio(now + keys[event.key])
    })
  }

  /** The toolbar menus, from the dataset on screen: page titles are masked when masking is on. */
  private fillControls(): void {
    const s = this.s
    const model = this.data.model
    this.search.value = this.filter.text
    this.scope.value = this.filter.scope
    const pages = pageChoices(model, s.noPage)
    this.pageSelect.replaceChildren(h('option', { value: '*' }, s.allPages), ...pages.map((page) => h('option', { value: page.value }, page.label)))
    this.pageSelect.hidden = pages.length < 2
    this.pageSelect.value = this.filter.page === null ? '*' : this.filter.page === '' ? '-' : `=${this.filter.page}`
    const domainOptions = [h('option', { value: '*' }, s.allDomains)]
    for (const domain of model.domains) domainOptions.push(h('option', { value: `=${domain.host}` }, `${domain.host || '—'} (${this.ctx.count(domain.count)})`))
    this.domainSelect.replaceChildren(...domainOptions)
    this.domainSelect.hidden = model.domains.length < 2
    this.domainSelect.value = this.filter.domain === null ? '*' : `=${this.filter.domain}`
  }

  // ── Refresh ──

  private refresh(): void {
    if (!this.plain) return
    const data = this.data
    const model = data.model
    this.order = sortIndexes(filterEntries(model, this.filter, data.haystacks), model.entries, this.sort)
    this.list.setData(model, this.order, this.sort, waterfallScale(model.entries, this.order, model.pages, this.filter.page), this.masking ? this.masked?.result.report.entries : undefined)
    this.list.setSelection(this.current, this.picked)
    this.errorsButton.setAttribute('aria-pressed', String(this.filter.errorsOnly))
    this.maskButton.setAttribute('aria-pressed', String(this.masking))
    this.pageSelect.value = this.filter.page === null ? '*' : this.filter.page === '' ? '-' : `=${this.filter.page}`
    this.domainSelect.value = this.filter.domain === null ? '*' : `=${this.filter.domain}`
    this.renderChips()
    this.renderNotices()
    this.renderSummary()
    this.renderDetails()
  }

  private renderChips(): void {
    const s = this.s
    const data = this.data
    const counts = new Map<ResourceType, number>()
    for (const index of filterEntries(data.model, { ...this.filter, types: new Set() }, data.haystacks)) {
      const type = data.model.entries[index].type
      counts.set(type, (counts.get(type) ?? 0) + 1)
    }
    const all = h('button', { type: 'button', className: 'hv-chip', 'aria-pressed': String(this.filter.types.size === 0) }, s.all)
    all.addEventListener('click', () => {
      this.filter.types = new Set()
      this.refresh()
    })
    const chips: HTMLElement[] = [all]
    for (const type of RESOURCE_TYPES) {
      const n = counts.get(type) ?? 0
      const chip = h(
        'button',
        { type: 'button', className: 'hv-chip', 'aria-pressed': String(this.filter.types.has(type)), title: s.chipHint },
        s.types[type],
        n ? h('span', { className: 'hv-count' }, this.ctx.count(n)) : null
      )
      chip.addEventListener('click', (event) => {
        const types = new Set(this.filter.types)
        if (event.metaKey || event.ctrlKey) {
          if (types.has(type)) types.delete(type)
          else types.add(type)
        } else if (types.size === 1 && types.has(type)) types.clear()
        else {
          types.clear()
          types.add(type)
        }
        this.filter.types = types
        this.refresh()
      })
      chips.push(chip)
    }
    this.chips.replaceChildren(...chips)
  }

  private renderNotices(): void {
    const s = this.s
    const recording = this.recording
    const out: HTMLElement[] = []
    const issue = recording?.issue
    if (issue) {
      const what = s.requests(issue.recovered)
      let text = fill(issue.kind === 'truncated' ? s.truncated : s.invalid, { line: issue.line, column: issue.column, message: issue.message, count: what })
      if (issue.skipped) text += ` ${fill(s.skipped, { n: this.ctx.count(issue.skipped) })}`
      out.push(h('div', { className: 'hv-notice hv-warn', role: 'alert' }, svg(icon('warning')), h('span', {}, text)))
    }
    if (recording && !recording.files && this.plain?.model.entries.some((e) => e.raw.response?.content?._file || e.raw.request?.postData?._file)) {
      out.push(h('div', { className: 'hv-notice hv-warn' }, svg(icon('warning')), h('span', {}, s.externalBodies)))
    }
    if (this.progress) out.push(h('div', { className: 'hv-notice hv-masked', role: 'status' }, svg(icon('shield')), this.progressText))
    if (this.masking && this.masked) {
      const report = this.masked.result.report
      const text = report.total
        ? fill(s.maskedBanner, { secrets: s.secrets(report.total), requests: s.inRequests(report.entries.size) })
        : s.maskedNone
      const show = h('button', { type: 'button', className: 'hv-btn' }, s.showValues)
      show.addEventListener('click', () => void this.setMasking(false))
      out.push(h('div', { className: 'hv-notice hv-masked', role: 'status' }, svg(icon('shield')), h('span', {}, text), show))
    }
    const failed = this.masked?.result.report.failed.size ?? 0
    if ((this.masking || this.prepared) && failed) {
      out.push(h('div', { className: 'hv-notice hv-warn', role: 'alert' }, svg(icon('warning')), h('span', {}, fill(s.maskFailed, { requests: s.inRequests(failed) }))))
    }
    if (this.prepared) {
      const copy = this.prepared
      const save = h('button', { type: 'button', className: 'hv-btn' }, s.saveCopy)
      save.addEventListener('click', () => this.save(copy))
      const text = fill(s.copyReady, { size: this.ctx.bytes(copy.data.length) })
      out.push(h('div', { className: 'hv-notice hv-masked', role: 'status' }, svg(icon('save')), h('span', {}, text), save))
    }
    this.notices.replaceChildren(...out)
  }

  private renderSummary(): void {
    const s = this.s
    const data = this.data
    const summary = summarize(data.model, this.order, this.filter.page)
    const items: Node[] = []
    items.push(h('span', {}, summary.count === summary.total ? s.requests(summary.total) : `${this.ctx.count(summary.count)} / ${s.requests(summary.total)}`))
    items.push(h('span', {}, fill(s.transferred, { size: this.ctx.bytes(summary.transferred) })))
    items.push(h('span', {}, fill(s.resources, { size: this.ctx.bytes(summary.resources) })))
    if (summary.finish > 0) items.push(h('span', {}, fill(s.finish, { time: this.ctx.ms(summary.finish) })))
    if (summary.page && summary.page.onContentLoad >= 0) items.push(h('span', { className: 'hv-dcl-text' }, fill(s.domContentLoaded, { time: this.ctx.ms(summary.page.onContentLoad) })))
    if (summary.page && summary.page.onLoad >= 0) items.push(h('span', { className: 'hv-load-text' }, fill(s.load, { time: this.ctx.ms(summary.page.onLoad) })))
    const errors = h('button', { type: 'button', className: `hv-link${summary.errors ? ' hv-err' : ''}`, title: s.errorsHint }, s.errors(summary.errors))
    errors.addEventListener('click', () => {
      this.filter.errorsOnly = !this.filter.errorsOnly
      this.refresh()
    })
    items.push(h('span', {}, errors))
    const link = (label: string, index: number, text: string) => {
      const button = h('button', { type: 'button', className: 'hv-link', title: data.model.entries[index].url }, text)
      button.addEventListener('click', () => this.select(index, 'only', true))
      return h('span', {}, `${label} `, button)
    }
    const slowest = summary.slowest[0]
    if (slowest) items.push(link(s.slowest, slowest.index, `${truncate(slowest.name, 28)} ${this.ctx.ms(slowest.time)}`))
    const largest = summary.largest[0]
    if (largest) items.push(link(s.largest, largest.index, `${truncate(largest.name, 28)} ${this.ctx.bytes(Math.max(largest.resourceSize, largest.transferSize))}`))
    const domains = h('button', { type: 'button', className: 'hv-link', title: s.domainsTitle }, s.domains(summary.domains.length))
    domains.addEventListener('click', () => {
      this.closeDetails()
      this.details.root.querySelector('.hv-ov-domains')?.scrollIntoView({ block: 'start' })
    })
    items.push(h('span', {}, domains))
    this.summaryEl.replaceChildren(...items)
  }

  private renderDetails(): void {
    const data = this.data
    if (this.current !== null) {
      const key = `${this.current}:${this.masking}:${data.model.entries.length}`
      if (key === this.detailsKey && this.details.showing) return
      this.detailsKey = key
      this.details.show(data.model.entries[this.current], data)
      return
    }
    this.detailsKey = ''
    const withoutDomain = this.filter.domain === null ? this.order : filterEntries(data.model, { ...this.filter, domain: null }, data.haystacks)
    const scroll = this.details.root.querySelector('.hv-overview')?.parentElement?.scrollTop ?? 0
    const view = overview(
      this.ctx,
      {
        model: data.model,
        indexes: this.order,
        summary: summarize(data.model, this.order, this.filter.page),
        domains: summarize(data.model, withoutDomain, this.filter.page).domains,
        activeDomain: this.filter.domain
      },
      {
        select: (index) => this.select(index, 'only', true),
        domain: (host) => {
          this.filter.domain = host
          this.refresh()
        }
      }
    )
    const scroller = h('div', { className: 'hv-dbody' }, view)
    this.details.showOther(scroller)
    scroller.scrollTop = scroll
  }

  // ── Selection, sorting, filters ──

  private select(index: number, how: 'only' | 'toggle' | 'range', reveal = false): void {
    if (how === 'toggle') {
      const picked = new Set(this.picked)
      if (picked.has(index)) {
        picked.delete(index)
        if (this.current === index) this.current = picked.size ? [...picked][picked.size - 1] : null
      } else {
        picked.add(index)
        this.current = index
      }
      this.picked = picked
      this.anchor = index
    } else if (how === 'range' && this.anchor !== null && this.order.includes(this.anchor)) {
      const a = this.order.indexOf(this.anchor)
      const b = this.order.indexOf(index)
      const [from, to] = a < b ? [a, b] : [b, a]
      this.picked = new Set(this.order.slice(from, to + 1))
      this.current = index
    } else {
      this.current = index
      this.picked = new Set([index])
      this.anchor = index
    }
    this.list.setSelection(this.current, this.picked)
    if (reveal && this.current !== null) this.list.reveal(this.current)
    this.renderDetails()
  }

  private closeDetails(): void {
    this.current = null
    this.picked = new Set()
    this.anchor = null
    this.list.setSelection(null, this.picked)
    this.renderDetails()
  }

  private toggleSort(key: SortKey): void {
    if (!this.sort || this.sort.key !== key) this.sort = { key, dir: key === 'transfer' || key === 'size' || key === 'time' ? -1 : 1 }
    else if (this.sort.dir === (key === 'transfer' || key === 'size' || key === 'time' ? -1 : 1)) this.sort = { key, dir: this.sort.dir === 1 ? -1 : 1 }
    else this.sort = null
    this.refresh()
  }

  private clearFilters(): void {
    const scope = this.filter.scope
    this.filter = { ...emptyFilter(), scope }
    this.search.value = ''
    this.refresh()
  }

  private onKey(event: KeyboardEvent): void {
    const mod = event.metaKey || event.ctrlKey
    if (mod && event.key.toLowerCase() === 'f') {
      if (!this.built) return
      event.preventDefault()
      this.search.focus()
      this.search.select()
      return
    }
    if (event.key === 'Escape') {
      if (this.exporter.isOpen) {
        this.exporter.close()
        this.exportButton.focus()
      } else if (event.target === this.search && this.search.value) {
        this.search.value = ''
        this.filter.text = ''
        this.refresh()
      } else if (this.current !== null) {
        this.closeDetails()
        this.list.focus()
      } else return
      event.preventDefault()
      return
    }
    if (!this.built || typingInto(event.target) || mod || event.altKey) return
    if (event.target instanceof Node && this.details.root.contains(event.target)) return
    const page = this.list.rowsInView
    const moves: Record<string, () => number | null> = {
      ArrowDown: () => this.list.step(this.current, 1),
      ArrowUp: () => this.list.step(this.current, -1),
      PageDown: () => this.list.step(this.current, page),
      PageUp: () => this.list.step(this.current, -page),
      Home: () => this.list.step(null, 1),
      End: () => this.list.step(null, -1)
    }
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    const next = move()
    if (next === null) return
    this.select(next, 'only', true)
  }

  // ── Masking, export, saving ──

  /** Whether masking this recording, or building its copy, is quick enough to run at once. */
  private isLight(): boolean {
    const recording = this.recording
    return !!recording && maskingWeight(recording.har, recording.files) <= QUICK
  }

  private finishMasking(result: Masked): MaskedView {
    const view = this.view(result.har, result.files)
    this.masked = { ...view, maskedEntries: result.report.entries, result }
    return this.masked
  }

  /** Never silently: masking stays off and the toast says why. */
  private maskingFailed(error: unknown): null {
    console.warn('[har-viewer] cannot mask this file', error)
    this.toast(fill(this.s.cannotMask, { message: error instanceof Error ? error.message : String(error) }))
    return null
  }

  /** The masked view, built now on this thread; null when masking failed. */
  private maskNow(): MaskedView | null {
    if (this.masked) return this.masked
    const recording = this.recording as Recording
    try {
      return this.finishMasking(maskRecording(recording.har, recording.files))
    } catch (error) {
      return this.maskingFailed(error)
    }
  }

  /** The masked view: at once for a light recording, else in slices with progress. Null when it failed or the file changed. */
  private maskedView(): Promise<MaskedView | null> {
    if (this.masked) return Promise.resolve(this.masked)
    if (this.job) return this.job
    if (this.isLight()) return Promise.resolve(this.maskNow())
    const recording = this.recording as Recording
    const generation = this.generation
    const current = () => generation === this.generation
    this.showProgress(this.s.maskingProgress, 0)
    this.job = runStepsAsync(maskSteps(recording.har, recording.files), (done) => current() && this.showProgress(this.s.maskingProgress, done))
      .then(
        (result) => (current() ? this.finishMasking(result) : null),
        (error) => (current() ? this.maskingFailed(error) : null)
      )
      .finally(() => {
        if (!current()) return
        this.job = null
        this.showProgress(null)
      })
    return this.job
  }

  /** Shows (or with null, hides) the progress notice; only its text changes while it stays. */
  private showProgress(template: string | null, done = 0): void {
    const shown = !!this.progress
    this.progress = template
    if (template) this.progressText.textContent = fill(template, { percent: `${Math.min(100, Math.round(done * 100))}%` })
    if (shown !== !!template) this.renderNotices()
  }

  private async setMasking(on: boolean): Promise<void> {
    if (!this.recording) return
    if (on) {
      const generation = this.generation
      const masked = await this.maskedView()
      if (!masked || generation !== this.generation) return
    }
    this.masking = on
    this.detailsKey = ''
    this.fillControls()
    this.refresh()
  }

  private async toggleExport(): Promise<void> {
    if (!this.recording) return
    const generation = this.generation
    const masked = this.masked ?? (await this.maskedView())
    if (!masked || generation !== this.generation) return
    const model = masked.model
    const selected = [...this.picked].filter((i) => i < model.entries.length)
    const failed = this.order.filter((i) => model.entries[i].isError)
    this.exporter.toggle({ model, files: masked.files, selected: sortByOrder(selected, this.order), failed, visible: this.order, date: isoDate(model.start) })
  }

  /**
   * "Save sanitized…". Orca opens the save dialog only within a few seconds of the click, so the
   * copy is built inside the click only when that is quick. A heavy one is built in slices with
   * progress first, and then a notice offers to save it with one more click.
   */
  private saveSanitized(): void {
    const recording = this.recording
    if (!this.ctx.saveAs || !recording) return
    if (this.prepared) return this.save(this.prepared)
    if (this.preparing) return
    if (!this.isLight()) {
      void this.prepareCopy()
      return
    }
    const masked = this.maskNow()
    if (!masked) return
    let copy: Copy | null
    try {
      copy = this.copyOf(recording, masked, recording.zip ? runSteps(maskedHarZipSteps(masked.result, recording.compact)) : null)
    } catch (error) {
      console.warn('[har-viewer] cannot build the sanitized copy', error)
      this.toast(this.s.saveFailed)
      return
    }
    if (copy) this.save(copy, true)
  }

  /** Builds the copy in slices with progress and offers it for saving. */
  private async prepareCopy(): Promise<void> {
    const recording = this.recording as Recording
    const generation = this.generation
    const current = () => generation === this.generation
    this.preparing = true
    try {
      const masked = await this.maskedView()
      if (!masked || !current()) return
      let zip: Uint8Array | null = null
      if (recording.zip) {
        this.showProgress(this.s.buildingCopy, 0)
        zip = await runStepsAsync(maskedHarZipSteps(masked.result, recording.compact), (done) => current() && this.showProgress(this.s.buildingCopy, done))
      }
      if (!current()) return
      this.prepared = this.copyOf(recording, masked, zip)
    } catch (error) {
      console.warn('[har-viewer] cannot build the sanitized copy', error)
      if (current()) this.toast(this.s.saveFailed)
    } finally {
      if (current()) {
        this.preparing = false
        this.progress = null
        this.renderNotices()
      }
    }
  }

  /** The file to save; null (with a toast) when it is more than Orca saves. */
  private copyOf(recording: Recording, masked: MaskedView, zip: Uint8Array | null): Copy | null {
    const data = zip ?? maskedHarBytes(masked.result, !!recording.compact, SAVE_LIMIT)
    if (data.length > SAVE_LIMIT) {
      this.toast(this.s.saveTooBig)
      return null
    }
    return {
      data,
      suggestedName: `sanitized-${isoDate(masked.model.start)}.${recording.zip ? 'har.zip' : 'har'}`,
      mimeType: recording.zip ? 'application/zip' : 'application/json'
    }
  }

  /**
   * Opens the save dialog for a built copy. When it was built inside the click and the dialog is
   * refused anyway (the click's gesture ran out on a slow machine), the copy is kept and offered.
   */
  private save(copy: Copy, offerOnRefusal = false): void {
    const saveAs = this.ctx.saveAs
    if (!saveAs) return
    const generation = this.generation
    saveAs({ suggestedName: copy.suggestedName, mimeType: copy.mimeType, data: copy.data })
      .then((result) => {
        if (result.status !== 'saved') return
        this.toast(this.s.saved)
        if (generation === this.generation && this.prepared === copy) {
          this.prepared = null
          this.renderNotices()
        }
      })
      .catch((error) => {
        console.warn('[har-viewer] save failed', error)
        if (offerOnRefusal && generation === this.generation) {
          this.prepared = copy
          this.renderNotices()
        } else this.toast(this.s.saveFailed)
      })
  }

  private toast(text: string): void {
    this.toastEl.textContent = text
    this.toastEl.classList.add('hv-show')
    clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('hv-show'), Math.max(1600, text.length * 45))
  }
}

function sortByOrder(indexes: number[], order: number[]): number[] {
  const position = new Map(order.map((index, pos) => [index, pos]))
  return [...indexes].sort((a, b) => (position.get(a) ?? Infinity) - (position.get(b) ?? Infinity) || a - b)
}

function isoDate(epoch: number): string {
  const date = epoch ? new Date(epoch) : new Date()
  return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10)
}

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}
