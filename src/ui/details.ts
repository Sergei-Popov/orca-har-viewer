// The details of one request, DevTools-style: Headers, Payload, Response, Cookies, Timing,
// WebSocket messages and Initiator. The tab and view choices carry over between requests.

import { append, h, maskedText, svg } from '../dom'
import { clockTime } from '../format'
import { parseJson, requestBody, responseBody } from '../har/body'
import { frameText, type FrameText } from '../har/frames'
import { formFields, queryFields } from '../har/fields'
import { safeUrl, toCurl, toFetch } from '../har/copy'
import { parseServerTiming, requestCookies, responseCookies } from '../har/headers'
import type { Entry } from '../har/model'
import type { HarCookie, HarNameValue, HarStack, HarWebSocketMessage } from '../har/types'
import { fill } from '../i18n'
import { icon } from '../icons'
import { copyText, headerRows, iconButton, kvList, note, section, type Ctx, type Dataset } from './common'
import { bodyView, hexView, jsonTree, sourceView, type Track, type ViewPrefs } from './viewers'

export type DetailTab = 'headers' | 'payload' | 'response' | 'cookies' | 'timing' | 'messages' | 'initiator'

export type DetailsEvents = {
  select(index: number): void
  close(): void
}

const PHASES = ['queueing', 'blocked', 'dns', 'connect', 'ssl', 'send', 'wait', 'receive'] as const
const PHASE_COLOR: Record<(typeof PHASES)[number], string> = {
  queueing: 'var(--wf-queue)',
  blocked: 'var(--wf-queue)',
  dns: 'var(--wf-dns)',
  connect: 'var(--wf-connect)',
  ssl: 'var(--wf-ssl)',
  send: 'var(--wf-send)',
  wait: 'var(--wf-wait)',
  receive: 'var(--wf-receive)'
}

export class DetailsPane {
  readonly root = h('div', { className: 'hv-details', role: 'region' })
  private tab: DetailTab = 'headers'
  private readonly prefs: ViewPrefs = { modes: {}, wrap: false }
  private readonly raw = { request: false, response: false }
  private disposers: (() => void)[] = []
  private messageFilter = ''
  private entry: Entry | null = null
  private data: Dataset | null = null

  constructor(
    private readonly ctx: Ctx,
    private readonly events: DetailsEvents
  ) {}

  get showing(): Entry | null {
    return this.entry
  }

  /** Puts other content (the overview) in the pane. */
  showOther(node: Node): void {
    this.dispose()
    this.entry = null
    this.data = null
    this.root.replaceChildren(node)
  }

  show(entry: Entry, data: Dataset): void {
    const keepScroll = this.entry?.index === entry.index && this.data?.model !== data.model
    const body = this.root.querySelector('.hv-dbody')
    const scroll = keepScroll && body ? body.scrollTop : 0
    this.dispose()
    this.entry = entry
    this.data = data
    const s = this.ctx.strings
    let tabs: DetailTab[]
    try {
      tabs = this.availableTabs(entry)
    } catch (error) {
      // A field of a type no recorder writes: the headers at least, never the previous request.
      console.warn('[har-viewer] cannot list the tabs of this request', error)
      tabs = ['headers']
    }
    if (!tabs.includes(this.tab)) this.tab = entry.raw._webSocketMessages?.length && tabs.includes('messages') ? 'messages' : 'headers'

    const status = entry.failed ? s.failed : String(entry.status)
    const pill = h('span', { className: `hv-pill${entry.isError ? ' hv-err' : entry.status < 300 ? ' hv-ok' : ''}`, title: entry.failed ? entry.error : entry.statusText }, status)
    const title = h('div', { className: 'hv-dtitle', title: entry.url }, `${entry.method} `, maskedText(entry.name || entry.url))
    const head = h(
      'div',
      { className: 'hv-dhead' },
      pill,
      title,
      iconButton('terminal', s.copyCurl, () => this.copy(toCurl(entry.raw, data.files)), 'cURL'),
      iconButton('code', s.copyFetch, () => this.copy(toFetch(entry.raw, data.files)), 'fetch'),
      iconButton('link', s.copyUrl, () => this.copy(safeUrl(entry.url) ? entry.url : null)),
      iconButton('close', s.close, () => this.events.close())
    )
    const tabBar = h('div', { className: 'hv-tabs', role: 'tablist' })
    const content = h('div', { className: 'hv-dbody', role: 'tabpanel' })
    for (const tab of tabs) {
      const button = h('button', { type: 'button', className: 'hv-tab', role: 'tab', 'aria-selected': String(tab === this.tab) }, s.tabs[tab])
      const n = this.tabCount(entry, tab)
      if (n !== null) button.append(h('span', { className: 'hv-count' }, String(n)))
      button.addEventListener('click', () => {
        this.tab = tab
        for (const other of Array.from(tabBar.children)) other.setAttribute('aria-selected', String(other === button))
        this.renderTab(content)
      })
      tabBar.append(button)
    }
    this.root.replaceChildren(head, tabBar, content)
    this.renderTab(content)
    if (scroll) content.scrollTop = scroll
  }

  /** Copies a command or URL; null means the file's request is not safe to paste into a terminal. */
  private copy(text: string | null): void {
    if (text === null) return this.ctx.toast(this.ctx.strings.copyUnsafe)
    void copyText(text).then((ok) => this.ctx.toast(ok ? this.ctx.strings.copied : this.ctx.strings.copyFailed))
  }

  private dispose(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
  }

  private readonly track: Track = (dispose) => this.disposers.push(dispose)

  private availableTabs(entry: Entry): DetailTab[] {
    const raw = entry.raw
    const tabs: DetailTab[] = ['headers']
    if ((Array.isArray(raw.request?.queryString) && raw.request.queryString.length > 0) || raw.request?.postData || entry.url.includes('?')) tabs.push('payload')
    const ws = Array.isArray(raw._webSocketMessages)
    if (!ws || responseBody(raw, this.data?.files).kind !== 'none') tabs.push('response')
    if (ws) tabs.push('messages')
    if (this.cookies(entry).request.length || this.cookies(entry).response.length) tabs.push('cookies')
    tabs.push('timing')
    if (raw._initiator || entry.initiator) tabs.push('initiator')
    return tabs
  }

  private tabCount(entry: Entry, tab: DetailTab): number | null {
    if (tab === 'messages') return Array.isArray(entry.raw._webSocketMessages) ? entry.raw._webSocketMessages.length : 0
    if (tab === 'cookies') {
      const { request, response } = this.cookies(entry)
      return request.length + response.length
    }
    return null
  }

  private cookies(entry: Entry): { request: HarCookie[]; response: HarCookie[] } {
    return {
      request: requestCookies(entry.raw.request?.cookies, entry.raw.request?.headers),
      response: responseCookies(entry.raw.response?.cookies, entry.raw.response?.headers)
    }
  }

  private renderTab(content: HTMLElement): void {
    this.dispose()
    const entry = this.entry
    const data = this.data
    if (!entry || !data) return
    content.scrollTop = 0
    let node: Node
    try {
      node = this.tabContent(entry, data)
    } catch (error) {
      console.warn('[har-viewer] cannot show this tab', error)
      node = note(fill(this.ctx.strings.tabFailed, { message: error instanceof Error ? error.message : String(error) }))
    }
    content.replaceChildren(node)
  }

  private tabContent(entry: Entry, data: Dataset): Node {
    let node: Node
    switch (this.tab) {
      case 'headers':
        node = this.headersTab(entry)
        break
      case 'payload':
        node = this.payloadTab(entry, data)
        break
      case 'response':
        node = this.responseTab(entry, data)
        break
      case 'cookies':
        node = this.cookiesTab(entry)
        break
      case 'timing':
        node = this.timingTab(entry, data)
        break
      case 'messages':
        node = this.messagesTab(entry)
        break
      case 'initiator':
        node = this.initiatorTab(entry, data)
        break
    }
    return node
  }

  // ── Headers ──

  private headersTab(entry: Entry): Node {
    const s = this.ctx.strings
    const raw = entry.raw
    const general: [string, string | Node][] = [
      [s.requestUrl, entry.url],
      [s.requestMethod, entry.method],
      [s.statusCode, entry.failed ? `${s.failed}${entry.error ? ` ${entry.error}` : ''}` : `${entry.status} ${entry.statusText}`]
    ]
    if (raw.serverIPAddress) general.push([s.remoteAddress, raw._serverPort ? `${raw.serverIPAddress}:${raw._serverPort}` : raw.serverIPAddress])
    if (entry.httpVersion) general.push([s.protocol, entry.httpVersion])
    if (entry.priority) general.push([s.priority, entry.priority])
    if (entry.cache) general.push([s.servedFrom, (s.caches[entry.cache] ?? entry.cache).replace(/[()]/g, '')])
    if (typeof raw.connection === 'string' && raw.connection) general.push([s.connection, raw.connection])
    if (Number.isFinite(entry.start)) general.push([s.startedAt, clockTime(entry.start)])
    if (entry.mimeType) general.push([s.type, `${entry.mimeType} · ${s.types[entry.type]}`])
    if (typeof raw.response?.redirectURL === 'string' && raw.response.redirectURL) general.push([s.redirectTo, raw.response.redirectURL])
    if (entry.error && !entry.failed) general.push([s.error, entry.error])

    const response = Array.isArray(raw.response?.headers) ? raw.response.headers : []
    const request = Array.isArray(raw.request?.headers) ? raw.request.headers : []
    const statusLine = `${entry.httpVersion || 'HTTP/1.1'} ${entry.status} ${entry.statusText}`
    let requestLine = `${entry.method} ${entry.path || '/'} ${raw.request?.httpVersion || entry.httpVersion || 'HTTP/1.1'}`
    if (!entry.path) requestLine = `${entry.method} ${entry.url}`
    return h(
      'div',
      {},
      section('general', s.general, kvList(general)),
      this.headerSection('response', s.responseHeaders, response, statusLine),
      this.headerSection('request', s.requestHeaders, request, requestLine)
    )
  }

  private headerSection(which: 'request' | 'response', title: string, headers: HarNameValue[], firstLine: string): HTMLElement {
    const s = this.ctx.strings
    const rows = headerRows(headers)
    const body = h('div')
    const render = () => {
      if (!rows.length) body.replaceChildren(h('div', { className: 'hv-muted' }, s.noHeaders))
      else if (this.raw[which]) body.replaceChildren(h('pre', { className: 'hv-raw' }, maskedText([firstLine, ...rows.map(([n, v]) => `${n}: ${v}`)].join('\n'))))
      else body.replaceChildren(kvList(rows, 'hv-headers'))
    }
    const toggle = h('button', { type: 'button', className: 'hv-btn', 'aria-pressed': String(this.raw[which]) }, s.raw)
    toggle.addEventListener('click', () => {
      this.raw[which] = !this.raw[which]
      toggle.setAttribute('aria-pressed', String(this.raw[which]))
      render()
    })
    render()
    return section(`headers-${which}`, title, body, { count: rows.length, actions: rows.length ? [toggle] : [] })
  }

  // ── Payload ──

  private payloadTab(entry: Entry, data: Dataset): Node {
    const s = this.ctx.strings
    const raw = entry.raw
    const root = h('div')
    // Each value decoded exactly once, from the URL and the body text (see har/fields.ts).
    const query = queryFields(raw, entry.url)
    if (query.length) root.append(section('payload-query', s.queryParams, kvList(query, 'hv-headers'), { count: query.length }))
    const post = raw.request?.postData
    const form = formFields(raw, data.files) ?? []
    if (form.length) root.append(section('payload-form', s.formData, kvList(form, 'hv-headers'), { count: form.length }))
    else if (post) root.append(section('payload-body', s.requestPayload, bodyView(requestBody(raw, data.files), this.ctx, this.prefs, this.track)))
    if (!root.childNodes.length) root.append(note(s.noPayload))
    return root
  }

  // ── Response ──

  private responseTab(entry: Entry, data: Dataset): Node {
    const body = responseBody(entry.raw, data.files)
    if (body.kind === 'none' && entry.status >= 300 && entry.status < 400) return note(this.ctx.strings.noRedirectBody)
    if (entry.failed && body.kind === 'none') return note(entry.error || this.ctx.strings.failed)
    return bodyView(body, this.ctx, this.prefs, this.track)
  }

  // ── Cookies ──

  private cookiesTab(entry: Entry): Node {
    const s = this.ctx.strings
    const { request, response } = this.cookies(entry)
    const root = h('div')
    if (request.length) {
      const table = h('table', { className: 'hv-table' }, h('tr', {}, h('th', {}, s.cookie.name), h('th', {}, s.cookie.value)))
      for (const c of request) table.append(h('tr', {}, h('td', { className: 'hv-wrapcell' }, c.name), h('td', { className: 'hv-wrapcell' }, maskedText(c.value ?? ''))))
      root.append(section('cookies-request', s.requestCookies, table, { count: request.length }))
    }
    if (response.length) {
      const cols = [s.cookie.name, s.cookie.value, s.cookie.domain, s.cookie.path, s.cookie.expires, s.cookie.httpOnly, s.cookie.secure, s.cookie.sameSite]
      const table = h('table', { className: 'hv-table' }, h('tr', {}, ...cols.map((c) => h('th', {}, c))))
      for (const c of response) {
        table.append(
          h(
            'tr',
            {},
            h('td', { className: 'hv-wrapcell' }, c.name),
            h('td', { className: 'hv-wrapcell' }, maskedText(c.value ?? '')),
            h('td', {}, c.domain ?? ''),
            h('td', {}, c.path ?? ''),
            h('td', {}, c.expires ? String(c.expires) : s.session),
            h('td', {}, c.httpOnly ? '✓' : ''),
            h('td', {}, c.secure ? '✓' : ''),
            h('td', {}, c.sameSite ?? '')
          )
        )
      }
      root.append(section('cookies-response', s.responseCookies, h('div', { style: 'overflow-x:auto' }, table), { count: response.length }))
    }
    if (!root.childNodes.length) root.append(note(s.noCookies))
    return root
  }

  // ── Timing ──

  private timingTab(entry: Entry, data: Dataset): Node {
    const s = this.ctx.strings
    const t = entry.timings
    const values: Record<(typeof PHASES)[number], number> = {
      ...t,
      // Chrome's queueing is part of "blocked"; the rest of it is the stall.
      blocked: t.queueing >= 0 && t.blocked >= 0 ? Math.max(0, t.blocked - t.queueing) : t.blocked
    }
    const total = Math.max(entry.time, PHASES.reduce((sum, p) => sum + Math.max(0, values[p]), 0), 0.001)
    const grid = h('div', { className: 'hv-timing' })
    let offset = 0
    const row = (phase: (typeof PHASES)[number]) => {
      const value = values[phase]
      const track = h('div', { className: 'hv-track' })
      if (value > 0) {
        track.append(h('i', { style: `left:${(offset / total) * 100}%;width:${(value / total) * 100}%;background:${PHASE_COLOR[phase]}` }))
        offset += value
      }
      append(
        grid,
        h('div', {}, h('span', { className: 'hv-swatch', style: `background:${PHASE_COLOR[phase]}` }), s.phases[phase]),
        track,
        h('div', { className: 'hv-num', style: 'text-align:right' }, value >= 0 ? this.ctx.ms(value) : '—')
      )
    }
    grid.append(h('div', { className: 'hv-group' }, s.phaseGroups.setup))
    for (const phase of ['queueing', 'blocked', 'dns', 'connect', 'ssl'] as const) {
      if (phase === 'queueing' && t.queueing < 0) continue
      row(phase)
    }
    grid.append(h('div', { className: 'hv-group' }, s.phaseGroups.request))
    for (const phase of ['send', 'wait', 'receive'] as const) row(phase)
    append(grid, h('div', { className: 'hv-total' }, s.total), h('div', { className: 'hv-total' }), h('div', { className: 'hv-total', style: 'text-align:right' }, this.ctx.ms(entry.time)))

    const root = h('div', { style: 'padding:6px 12px 12px' })
    if (Number.isFinite(entry.start)) {
      root.append(h('div', { className: 'hv-muted', style: 'margin-bottom:4px' }, fill(s.startedAfter, { clock: clockTime(entry.start), offset: this.ctx.ms(entry.start - data.model.start) })))
    }
    root.append(grid)
    const serverTiming = (Array.isArray(entry.raw.response?.headers) ? entry.raw.response.headers : [])
      .filter((header) => typeof header?.name === 'string' && header.name.toLowerCase() === 'server-timing')
      .flatMap((header) => parseServerTiming(String(header.value ?? '')))
    if (serverTiming.length) {
      const longest = Math.max(1, ...serverTiming.map((m) => m.duration))
      const table = h('div', { className: 'hv-timing hv-st' }, h('div', { className: 'hv-group' }, s.serverTiming))
      for (const metric of serverTiming) {
        const track = h('div', { className: 'hv-track' })
        if (metric.duration > 0) track.append(h('i', { style: `left:0;width:${(metric.duration / longest) * 100}%;background:var(--wf-wait);opacity:.7` }))
        append(
          table,
          h('div', { title: metric.name }, metric.description ? (metric.duration >= 0 ? metric.description : `${metric.name}: ${metric.description}`) : metric.name),
          track,
          h('div', { style: 'text-align:right' }, metric.duration >= 0 ? this.ctx.ms(metric.duration) : '')
        )
      }
      root.append(table)
    }
    root.append(h('p', { className: 'hv-muted', style: 'margin:12px 0 0' }, s.timingNote))
    return root
  }

  // ── WebSocket messages ──

  private messagesTab(entry: Entry): Node {
    const s = this.ctx.strings
    const messages = (Array.isArray(entry.raw._webSocketMessages) ? entry.raw._webSocketMessages : []).filter((m): m is HarWebSocketMessage => !!m && typeof m === 'object')
    if (!messages.length) return note(s.noMessages)
    const root = h('div', { className: 'hv-msgs' })
    const input = h('input', { type: 'search', placeholder: s.filterMessages, value: this.messageFilter, style: 'height:24px;padding:0 6px' })
    input.className = 'hv-select'
    const list = h('div', { className: 'hv-msg-list' })
    const detail = h('div', { className: 'hv-msg-detail' }, note(s.selectMessage))
    let chosen: HTMLElement | null = null
    // Icons parsed once and cloned; frame text lowercased once, when the filter first needs it.
    const icons = { send: svg(icon('up')), receive: svg(icon('down')) }
    const lower: (string | undefined)[] = []
    const texts = new Map<number, FrameText>()
    const textOf = (i: number) => {
      let text = texts.get(i)
      if (!text) texts.set(i, (text = frameText(messages[i])))
      return text
    }
    const row = (i: number) => {
      const message = messages[i]
      const data = typeof message.data === 'string' ? message.data : message.data == null ? '' : JSON.stringify(message.data)
      const text = textOf(i)
      const send = message.type === 'send'
      const binary = message.opcode !== undefined && message.opcode !== 1
      const label = binary ? `${s.opcodes[message.opcode as number] ?? message.opcode}${text.text !== null ? ` · ${text.text}` : ''}` : data
      const tr = h(
        'tr',
        { className: 'hv-clickable' },
        h('td', { className: send ? 'hv-dir-send' : 'hv-dir-receive', title: send ? s.sent : s.received }, (send ? icons.send : icons.receive).cloneNode(true)),
        h('td', { className: 'hv-msg-data' }, maskedText(label.slice(0, 300))),
        h('td', { className: 'hv-num' }, this.ctx.count(text.bytes ? text.bytes.length : data.length)),
        h('td', { className: 'hv-num' }, typeof message.time === 'number' ? clockTime(message.time * 1000) : '')
      )
      tr.addEventListener('click', () => {
        chosen?.classList.remove('hv-active')
        chosen = tr
        tr.classList.add('hv-active')
        detail.replaceChildren(frameView(message, textOf(i), this.ctx))
      })
      return tr
    }
    const render = () => {
      const needle = this.messageFilter.toLowerCase()
      const table = h('table', { className: 'hv-table' }, h('tr', {}, h('th', {}), h('th', {}, s.data), h('th', { className: 'hv-num' }, s.length), h('th', { className: 'hv-num' }, s.time)))
      const matches: number[] = []
      for (let i = 0; i < messages.length; i++) {
        if (needle && !(lower[i] ??= (messages[i].data ?? '').toLowerCase()).includes(needle)) continue
        matches.push(i)
      }
      // Rows a page at a time: a long-lived socket can hold tens of thousands of frames.
      let shown = 0
      const more = h('button', { type: 'button', className: 'hv-more' })
      const moreRow = h('tr', {}, h('td', { colspan: 4 }, more))
      const page = () => {
        moreRow.remove()
        const to = Math.min(matches.length, shown + MESSAGE_PAGE)
        for (; shown < to; shown++) table.append(row(matches[shown]))
        if (shown < matches.length) {
          more.textContent = fill(s.moreMessages, { n: this.ctx.count(Math.min(MESSAGE_PAGE, matches.length - shown)) })
          table.append(moreRow)
        }
      }
      more.addEventListener('click', page)
      page()
      list.replaceChildren(table)
    }
    let timer = 0
    input.addEventListener('input', () => {
      this.messageFilter = input.value
      clearTimeout(timer)
      timer = window.setTimeout(render, FILTER_DELAY)
    })
    render()
    root.append(h('div', { className: 'hv-subbar' }, input, h('span', {}, s.messages(messages.length))), list, detail)
    return root
  }

  // ── Initiator ──

  private initiatorTab(entry: Entry, data: Dataset): Node {
    const s = this.ctx.strings
    const raw = entry.raw._initiator
    const initiator = typeof raw === 'object' && raw ? raw : null
    const root = h('div')
    const facts: [string, string | Node][] = []
    if (entry.initiatorType) facts.push([s.initiatorType, entry.initiatorType])
    if (entry.initiator) facts.push([s.initiatedBy, entry.initiatorUrl ? this.urlLink(entry.initiatorUrl, entry.initiator, data, entry) : entry.initiator])
    if (facts.length) root.append(section('initiator-facts', s.tabs.initiator, kvList(facts)))
    if (initiator?.stack) root.append(section('initiator-stack', s.callStack, this.stackView(initiator.stack, data, entry)))
    const parent = entry.initiatorUrl ? findRequest(data, entry.initiatorUrl, entry) : null
    if (parent) root.append(section('initiator-parent', s.startedBy, this.requestLinks([parent])))
    const children = data.model.entries.filter((other) => other.index !== entry.index && other.initiatorUrl && other.initiatorUrl === entry.url)
    if (children.length) root.append(section('initiator-children', s.startedRequests, this.requestLinks(children.slice(0, 200)), { count: children.length }))
    if (!root.childNodes.length) root.append(note(s.noInitiator))
    return root
  }

  private stackView(stack: HarStack, data: Dataset, entry: Entry): Node {
    const s = this.ctx.strings
    const table = h('table', { className: 'hv-table' })
    for (let level: HarStack | undefined = stack, depth = 0; level && depth < 64; level = level.parent, depth++) {
      if (depth > 0 || level.description) table.append(h('tr', {}, h('td', { colspan: 2, className: 'hv-muted' }, level.description ?? '')))
      for (const frame of Array.isArray(level.callFrames) ? level.callFrames : []) {
        if (!frame || typeof frame !== 'object') continue
        const url = typeof frame.url === 'string' ? frame.url : ''
        const line = typeof frame.lineNumber === 'number' ? frame.lineNumber : 0
        const where = url ? `${url.split('/').pop() || url}:${line + 1}${typeof frame.columnNumber === 'number' ? `:${frame.columnNumber + 1}` : ''}` : ''
        table.append(
          h(
            'tr',
            {},
            h('td', { className: 'hv-wrapcell' }, (typeof frame.functionName === 'string' && frame.functionName) || s.anonymous),
            h('td', { className: 'hv-wrapcell' }, url ? this.urlLink(url, where, data, entry) : '')
          )
        )
      }
    }
    return table
  }

  private urlLink(url: string, label: string, data: Dataset, entry: Entry): Node {
    const target = findRequest(data, url, entry)
    if (!target) return h('span', { title: url }, label)
    const link = h('button', { type: 'button', className: 'hv-link', title: url }, label)
    link.addEventListener('click', () => this.events.select(target.index))
    return link
  }

  private requestLinks(entries: Entry[]): Node {
    const list = h('div', { style: 'display:flex;flex-direction:column;gap:2px' })
    for (const other of entries) {
      const link = h('button', { type: 'button', className: 'hv-link', title: other.url, style: 'max-width:100%;text-align:left' }, `${other.method} ${other.name || other.url}`)
      link.addEventListener('click', () => this.events.select(other.index))
      list.append(h('div', {}, link, h('span', { className: 'hv-muted' }, ` · ${other.failed ? this.ctx.strings.failed : other.status} · ${this.ctx.ms(other.time)}`)))
    }
    return list
  }
}

/** The request for `url` that started last before `entry` (or the first one at all). */
function findRequest(data: Dataset, url: string, entry: Entry): Entry | null {
  let best: Entry | null = null
  for (const other of data.model.entries) {
    if (other.url !== url || other.index === entry.index) continue
    if (!best) best = other
    if (Number.isFinite(other.start) && other.start <= entry.start && (!Number.isFinite(best.start) || best.start > entry.start || other.start > best.start)) best = other
  }
  return best
}

/** Frames built per page of the Messages tab. */
const MESSAGE_PAGE = 500
/** Typing pause before the message filter runs, as for the request filter. */
const FILTER_DELAY = 150

function frameView(message: HarWebSocketMessage, frame: FrameText, ctx: Ctx): Node {
  const text = frame.text
  if (text !== null) {
    const start = text.trimStart()[0]
    const json = start === '{' || start === '[' ? parseJson(text) : undefined
    return json !== undefined ? jsonTree(json) : sourceView(text, 'text', ctx, true)
  }
  if (frame.bytes) return hexView(frame.bytes, ctx)
  return note(`${ctx.strings.opcodes[message.opcode as number] ?? message.opcode}${message.data ? ` · ${message.data}` : ''}`)
}
