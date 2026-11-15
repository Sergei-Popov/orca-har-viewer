// The HAR as the viewer uses it: one flat record per request with the numbers worked out once
// (start time, sizes, type, status), keeping the raw entry for the details pane.

import { classify, type ResourceType } from './classify'
import type { Har, HarEntry, HarInitiator, HarNameValue, HarPage } from './types'

export type Timings = {
  /** Chrome's `_blocked_queueing`, part of `blocked`. */
  queueing: number
  blocked: number
  dns: number
  /** TCP connect without TLS. */
  connect: number
  ssl: number
  send: number
  wait: number
  receive: number
}

export type Entry = {
  /** Position in `log.entries`. */
  index: number
  raw: HarEntry
  method: string
  url: string
  scheme: string
  /** Host with a port when it is not the default one. */
  host: string
  /** Path and query. */
  path: string
  /** Last path segment with the query, as DevTools' Name column; the host for "/". */
  name: string
  status: number
  statusText: string
  /** No response: status 0 or -1, or an error text. */
  failed: boolean
  error: string
  /** 4xx, 5xx or failed. */
  isError: boolean
  type: ResourceType
  mimeType: string
  initiator: string
  initiatorType: string
  initiatorUrl: string
  /** Bytes over the wire, -1 when unknown. */
  transferSize: number
  /** Body size after decoding, -1 when unknown. */
  resourceSize: number
  /** 'memory', 'disk', 'service worker', 'cache' or ''. */
  cache: string
  /** Epoch milliseconds; NaN when the file has no start time. */
  start: number
  /** Total milliseconds. */
  time: number
  timings: Timings
  pageId: string
  priority: string
  httpVersion: string
}

export type Page = {
  id: string
  title: string
  start: number
  /** Milliseconds after `start`, -1 when unknown. */
  onContentLoad: number
  onLoad: number
}

export type Model = {
  har: Har
  entries: Entry[]
  pages: Page[]
  /** "Chrome 131.0", "Firefox 133.0", "Playwright 1.49.0"… */
  creator: string
  /** Earliest start and latest end over all entries (epoch ms); 0 when unknown. */
  start: number
  end: number
  hasInitiator: boolean
  /** Hosts, most requests first. */
  domains: { host: string; count: number }[]
}

export function buildModel(har: Har): Model {
  const raw = har.log.entries ?? []
  const entries = raw.map((entry, index) => toEntry(entry, index))
  const pages = toPages(har.log.pages ?? [], entries)
  let start = Infinity
  let end = -Infinity
  let hasInitiator = false
  const hostCounts = new Map<string, number>()
  for (const entry of entries) {
    if (Number.isFinite(entry.start)) {
      start = Math.min(start, entry.start)
      end = Math.max(end, entry.start + Math.max(0, entry.time))
    }
    if (entry.initiator) hasInitiator = true
    hostCounts.set(entry.host, (hostCounts.get(entry.host) ?? 0) + 1)
  }
  for (const page of pages) {
    if (Number.isFinite(page.start)) {
      start = Math.min(start, page.start)
      if (page.onLoad > 0) end = Math.max(end, page.start + page.onLoad)
    }
  }
  const domains = [...hostCounts]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host))
  return {
    har,
    entries,
    pages,
    creator: describeCreator(har),
    start: Number.isFinite(start) ? start : 0,
    end: Number.isFinite(end) ? end : 0,
    hasInitiator,
    domains
  }
}

function describeCreator(har: Har): string {
  const pick = (c: { name?: string; version?: string } | undefined) =>
    c && typeof c.name === 'string' && c.name ? `${c.name}${c.version ? ` ${c.version}` : ''}` : ''
  const browser = pick(har.log.browser)
  const creator = pick(har.log.creator)
  if (browser && creator && !creator.toLowerCase().startsWith(browser.split(' ')[0].toLowerCase())) {
    return `${creator} · ${browser}`
  }
  return creator || browser
}

function toPages(pages: HarPage[], entries: Entry[]): Page[] {
  const result: Page[] = []
  const seen = new Set<string>()
  for (const page of pages) {
    const id = typeof page.id === 'string' ? page.id : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push({
      id,
      title: typeof page.title === 'string' && page.title ? page.title : id,
      start: parseTime(page.startedDateTime),
      onContentLoad: num(page.pageTimings?.onContentLoad),
      onLoad: num(page.pageTimings?.onLoad)
    })
  }
  // Entries may name pages the file does not list.
  for (const entry of entries) {
    if (entry.pageId && !seen.has(entry.pageId)) {
      seen.add(entry.pageId)
      result.push({ id: entry.pageId, title: entry.pageId, start: entry.start, onContentLoad: -1, onLoad: -1 })
    }
  }
  return result
}

/** A finite number ≥ 0, or -1. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : -1
}

/** ISO 8601 → epoch ms with the sub-millisecond part kept. */
export function parseTime(value: unknown): number {
  if (typeof value !== 'string' || !value) return NaN
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return NaN
  const fraction = /\.(\d{4,})/.exec(value)
  if (!fraction) return ms
  // Date.parse keeps milliseconds only.
  const extra = Number(`0.${fraction[1].slice(3)}`)
  return ms + extra
}

export function headerValue(headers: HarNameValue[] | undefined, name: string): string {
  if (!Array.isArray(headers)) return ''
  const lower = name.toLowerCase()
  for (const header of headers) {
    if (header && typeof header.name === 'string' && header.name.toLowerCase() === lower) {
      return typeof header.value === 'string' ? header.value : String(header.value ?? '')
    }
  }
  return ''
}

function toEntry(raw: HarEntry, index: number): Entry {
  const request = raw.request ?? {}
  const response = raw.response ?? {}
  const url = typeof request.url === 'string' ? request.url : ''
  const parts = splitUrl(url)
  const rawStatus = typeof response.status === 'number' ? response.status : 0
  const error = errorText(raw)
  const failed = rawStatus <= 0 || !!error
  const status = rawStatus > 0 ? rawStatus : 0
  const mimeType = (response.content?.mimeType ?? '').split(';')[0].trim().toLowerCase()
  const timings = toTimings(raw)
  const time = totalTime(raw.time, timings)
  const initiator = describeInitiator(raw._initiator)
  const cache = cacheKind(raw)
  return {
    index,
    raw,
    method: typeof request.method === 'string' && request.method ? request.method.toUpperCase() : 'GET',
    url,
    ...parts,
    status,
    statusText: typeof response.statusText === 'string' && response.statusText ? response.statusText : reasonPhrase(status),
    failed,
    error,
    isError: failed || status >= 400,
    type: classify(raw, parts.scheme, parts.path, mimeType),
    mimeType,
    initiator: initiator.label,
    initiatorType: initiator.type,
    initiatorUrl: initiator.url,
    transferSize: transferSize(raw, cache),
    resourceSize: resourceSize(raw),
    cache,
    start: parseTime(raw.startedDateTime),
    time,
    timings,
    pageId: typeof raw.pageref === 'string' ? raw.pageref : '',
    priority: typeof raw._priority === 'string' ? raw._priority : '',
    httpVersion: typeof response.httpVersion === 'string' && response.httpVersion ? response.httpVersion : (request.httpVersion ?? '')
  }
}

function errorText(raw: HarEntry): string {
  const candidates = [raw._error, raw.response?._error, raw.response?._failureText]
  for (const value of candidates) if (typeof value === 'string' && value) return value
  return ''
}

export function splitUrl(url: string): { scheme: string; host: string; path: string; name: string } {
  const colon = url.indexOf(':')
  const scheme = colon > 0 ? url.slice(0, colon).toLowerCase() : ''
  if (scheme === 'data' || scheme === 'blob' || scheme === 'about') {
    const short = url.length > 80 ? `${url.slice(0, 77)}…` : url
    return { scheme, host: '', path: short, name: short }
  }
  let parsed: URL | null = null
  try {
    parsed = new URL(url)
  } catch {
    parsed = null
  }
  if (!parsed) return { scheme, host: '', path: url, name: url || '—' }
  const path = `${parsed.pathname}${parsed.search}`
  const segments = parsed.pathname.split('/').filter(Boolean)
  const last = segments.length ? decodeSafe(segments[segments.length - 1]) : ''
  const name = last ? `${last}${parsed.search}` : parsed.search ? `${parsed.host}/${parsed.search}` : parsed.host || url
  return { scheme, host: parsed.host, path, name }
}

function decodeSafe(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function toTimings(raw: HarEntry): Timings {
  const t = raw.timings ?? {}
  const ssl = num(t.ssl)
  let connect = num(t.connect)
  // HAR 1.2: ssl is included in connect.
  if (connect >= 0 && ssl > 0) connect = Math.max(0, connect - ssl)
  const queueing = num(t._blocked_queueing)
  return {
    queueing,
    blocked: num(t.blocked),
    dns: num(t.dns),
    connect,
    ssl,
    send: num(t.send),
    wait: num(t.wait),
    receive: num(t.receive)
  }
}

function totalTime(time: unknown, t: Timings): number {
  if (typeof time === 'number' && Number.isFinite(time) && time >= 0) return time
  let sum = 0
  for (const value of [t.blocked, t.dns, t.connect, t.ssl, t.send, t.wait, t.receive]) if (value > 0) sum += value
  return sum
}

function cacheKind(raw: HarEntry): string {
  const from = raw._fromCache
  if (from === 'memory' || from === 'disk') return from
  if (raw._fromServiceWorker || raw._wasFetchedViaServiceWorker) return 'service worker'
  if (raw._fromDiskCache) return 'disk'
  if (from === true || (typeof from === 'string' && from)) return 'cache'
  return ''
}

function transferSize(raw: HarEntry, cache: string): number {
  const response = raw.response ?? {}
  for (const value of [raw._transferSize, response._transferSize]) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  if (cache === 'memory' || cache === 'disk') return 0
  const body = num(response.bodySize)
  const headers = num(response.headersSize)
  if (body >= 0 && headers >= 0) return body + headers
  if (body >= 0) return body
  return -1
}

function resourceSize(raw: HarEntry): number {
  const content = raw.response?.content
  const size = num(content?.size)
  if (size >= 0) return size
  const text = content?.text
  if (typeof text === 'string') {
    if (content?.encoding === 'base64') return Math.floor((text.replace(/=+$/, '').length * 3) / 4)
    return new TextEncoder().encode(text).length
  }
  return -1
}

function describeInitiator(value: HarInitiator | string | undefined): { label: string; type: string; url: string } {
  if (typeof value === 'string') return { label: value, type: value, url: '' }
  if (!value || typeof value !== 'object') return { label: '', type: '', url: '' }
  const type = typeof value.type === 'string' ? value.type : ''
  let url = typeof value.url === 'string' ? value.url : ''
  let line = typeof value.lineNumber === 'number' ? value.lineNumber : -1
  // Script initiators name the top frame of their stack.
  let stack = value.stack
  while (!url && stack) {
    const frame = stack.callFrames?.find((f) => f && typeof f.url === 'string' && f.url)
    if (frame) {
      url = frame.url ?? ''
      line = typeof frame.lineNumber === 'number' ? frame.lineNumber : -1
    }
    stack = stack.parent
  }
  if (!url) return { label: type, type, url: '' }
  const file = splitUrl(url).name || url
  // CDP line numbers are 0-based.
  return { label: line >= 0 ? `${file}:${line + 1}` : file, type, url }
}

const REASONS: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  103: 'Early Hints',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout'
}

export function reasonPhrase(status: number): string {
  return REASONS[status] ?? ''
}
