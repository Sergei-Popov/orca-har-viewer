// Filtering and sorting the request list. The text filter is a small DevTools-like language:
// words must all match (`-word` must not), `status:404`, `method:post`, `domain:api.*`,
// `type:js`, `mime:json`, `larger-than:100k`, `slower-than:500`, `has-response-header:x-cache`,
// and `/regex/`. A word is looked up in the URL, plus headers and bodies with a wider scope.

import { bodyText, requestBody, responseBody, type SideFiles } from './body'
import type { ResourceType } from './classify'
import type { Entry, Model } from './model'

export type Scope = 'url' | 'headers' | 'all'

export type FilterState = {
  text: string
  scope: Scope
  /** Empty: every type. */
  types: Set<ResourceType>
  errorsOnly: boolean
  /** null: every page; '': entries without a page. */
  page: string | null
  /** null: every domain. */
  domain: string | null
}

export function emptyFilter(): FilterState {
  return { text: '', scope: 'url', types: new Set(), errorsOnly: false, page: null, domain: null }
}

type Term =
  | { kind: 'text'; value: string; negate: boolean }
  | { kind: 'regex'; value: RegExp; negate: boolean }
  | { kind: 'prop'; key: string; value: string; negate: boolean }

const PROPS = new Set([
  'status',
  'status-code',
  'method',
  'domain',
  'type',
  'mime',
  'mime-type',
  'larger-than',
  'slower-than',
  'scheme',
  'has-response-header',
  'has-request-header',
  'is'
])

/** Splits the filter text into terms; quotes keep spaces. */
export function parseQuery(text: string): Term[] {
  const terms: Term[] = []
  const re = /(-?)(?:"([^"]*)"|(\S+))/g
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const negate = match[1] === '-'
    const word = match[2] ?? match[3] ?? ''
    if (!word) continue
    const regex = /^\/(.+)\/([imsu]*)$/.exec(word)
    if (regex && match[2] === undefined) {
      try {
        terms.push({ kind: 'regex', value: new RegExp(regex[1], regex[2].includes('i') ? regex[2] : `${regex[2]}i`), negate })
        continue
      } catch {
        // Not a valid pattern: a plain word.
      }
    }
    const colon = word.indexOf(':')
    if (colon > 0 && match[2] === undefined) {
      const key = word.slice(0, colon).toLowerCase()
      if (PROPS.has(key)) {
        terms.push({ kind: 'prop', key, value: word.slice(colon + 1).toLowerCase(), negate })
        continue
      }
    }
    terms.push({ kind: 'text', value: word.toLowerCase(), negate })
  }
  return terms
}

/** Text an entry is searched in, per scope; built on first use and kept. */
/**
 * Characters of each body (and of an entry's WebSocket frames together) that search looks at:
 * far more than real bodies have, and it keeps a crafted archive from holding gigabytes of text.
 */
export const SEARCH_BODY_CHARS = 2 * 1024 * 1024

export class Haystacks {
  private readonly url = new Map<number, string>()
  private readonly headers = new Map<number, string>()
  private readonly bodies = new Map<number, string>()

  constructor(private readonly files?: SideFiles) {}

  get(entry: Entry, scope: Scope): string[] {
    const parts = [this.urlOf(entry)]
    if (scope !== 'url') parts.push(this.headersOf(entry))
    if (scope === 'all') parts.push(this.bodiesOf(entry))
    return parts
  }

  private urlOf(entry: Entry): string {
    let text = this.url.get(entry.index)
    if (text === undefined) {
      text = safeDecodeUri(entry.url).toLowerCase()
      this.url.set(entry.index, text)
    }
    return text
  }

  private headersOf(entry: Entry): string {
    let text = this.headers.get(entry.index)
    if (text === undefined) {
      const lines: string[] = []
      for (const list of [entry.raw.request?.headers, entry.raw.response?.headers]) {
        if (Array.isArray(list)) for (const h of list) if (h) lines.push(`${h.name}: ${h.value}`)
      }
      for (const list of [entry.raw.request?.cookies, entry.raw.response?.cookies]) {
        if (Array.isArray(list)) for (const c of list) if (c) lines.push(`${c.name}=${c.value}`)
      }
      if (entry.error) lines.push(entry.error)
      text = lines.join('\n').toLowerCase()
      this.headers.set(entry.index, text)
    }
    return text
  }

  private bodiesOf(entry: Entry): string {
    let text = this.bodies.get(entry.index)
    if (text === undefined) {
      const parts: string[] = []
      for (const body of [requestBody(entry.raw, this.files), responseBody(entry.raw, this.files)]) {
        const value = bodyText(body)
        if (value) parts.push(value.length > SEARCH_BODY_CHARS ? value.slice(0, SEARCH_BODY_CHARS) : value)
      }
      const messages = entry.raw._webSocketMessages
      let room = SEARCH_BODY_CHARS
      if (Array.isArray(messages)) {
        for (const m of messages) {
          if (room <= 0) break
          if (!m || typeof m.data !== 'string') continue
          const data = m.data.length > room ? m.data.slice(0, room) : m.data
          parts.push(data)
          room -= data.length
        }
      }
      // Two parts at least, so the join copies: a slice alone could keep its whole body alive.
      text = ['', ...parts].join('\n').toLowerCase()
      this.bodies.set(entry.index, text)
    }
    return text
  }
}

function safeDecodeUri(url: string): string {
  try {
    return `${url}\n${decodeURI(url)}`
  } catch {
    return url
  }
}

/** Bytes from `100`, `10k`, `1.5M`, `2kb`. */
export function parseSize(value: string): number {
  const match = /^([\d.]+)\s*([kmg]?)i?b?$/i.exec(value.trim())
  if (!match) return NaN
  const scale = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2].toLowerCase() as '' | 'k' | 'm' | 'g']
  return Number(match[1]) * scale
}

/** Milliseconds from `500`, `500ms`, `1.5s`. */
export function parseDuration(value: string): number {
  const match = /^([\d.]+)\s*(ms|s)?$/i.exec(value.trim())
  if (!match) return NaN
  return Number(match[1]) * (match[2]?.toLowerCase() === 's' ? 1000 : 1)
}

function wildcard(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

function hasHeader(list: { name: string }[] | undefined, name: string): boolean {
  return Array.isArray(list) && list.some((h) => h && typeof h.name === 'string' && h.name.toLowerCase() === name)
}

function matchProp(entry: Entry, key: string, value: string): boolean {
  switch (key) {
    case 'status':
    case 'status-code':
      if (value === 'failed' || value === '0') return entry.failed
      if (/^\dxx$/.test(value)) return Math.floor(entry.status / 100) === Number(value[0])
      return String(entry.status) === value
    case 'method':
      return entry.method.toLowerCase() === value
    case 'domain':
      return value.includes('*') || value.includes('?') ? wildcard(value).test(entry.host) : entry.host.toLowerCase().includes(value)
    case 'type':
      return entry.type === value || (value === 'xhr' && entry.type === 'fetch')
    case 'mime':
    case 'mime-type':
      return entry.mimeType.includes(value)
    case 'larger-than': {
      const size = parseSize(value)
      return Number.isFinite(size) && Math.max(entry.transferSize, entry.resourceSize) > size
    }
    case 'slower-than': {
      const ms = parseDuration(value)
      return Number.isFinite(ms) && entry.time > ms
    }
    case 'scheme':
      return entry.scheme === value
    case 'has-response-header':
      return hasHeader(entry.raw.response?.headers, value)
    case 'has-request-header':
      return hasHeader(entry.raw.request?.headers, value)
    case 'is':
      if (value === 'error' || value === 'failed') return entry.isError
      if (value === 'cached' || value === 'from-cache') return !!entry.cache
      if (value === 'running') return entry.status === 0 && !entry.error
      return false
    default:
      return true
  }
}

/** Indexes (into `model.entries`) that pass the filter, in file order. */
export function filterEntries(model: Model, filter: FilterState, haystacks: Haystacks): number[] {
  const terms = parseQuery(filter.text)
  const out: number[] = []
  for (const entry of model.entries) {
    if (filter.types.size && !filter.types.has(entry.type)) continue
    if (filter.errorsOnly && !entry.isError) continue
    if (filter.page !== null && entry.pageId !== filter.page) continue
    if (filter.domain !== null && entry.host !== filter.domain) continue
    if (terms.length && !safeMatches(entry, terms, filter.scope, haystacks)) continue
    out.push(entry.index)
  }
  return out
}

/** An entry whose text cannot be searched (a body the engine cannot hold as a string) does not match. */
function safeMatches(entry: Entry, terms: Term[], scope: Scope, haystacks: Haystacks): boolean {
  try {
    return matchesTerms(entry, terms, scope, haystacks)
  } catch {
    return false
  }
}

function matchesTerms(entry: Entry, terms: Term[], scope: Scope, haystacks: Haystacks): boolean {
  let texts: string[] | null = null
  for (const term of terms) {
    let hit: boolean
    if (term.kind === 'prop') hit = matchProp(entry, term.key, term.value)
    else {
      texts ??= haystacks.get(entry, scope)
      hit =
        term.kind === 'text'
          ? texts.some((text) => text.includes(term.value))
          : texts.some((text) => {
              term.value.lastIndex = 0
              return term.value.test(text)
            })
    }
    if (hit === term.negate) return false
  }
  return true
}

// ── Sorting ──────────────────────────────────────────────────────────────────────────────────

export type SortKey =
  | 'status'
  | 'method'
  | 'domain'
  | 'path'
  | 'type'
  | 'initiator'
  | 'transfer'
  | 'size'
  | 'time'
  | 'waterfall'

export type Sort = { key: SortKey; dir: 1 | -1 } | null

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

function compare(a: Entry, b: Entry, key: SortKey): number {
  switch (key) {
    case 'status':
      return (a.failed ? -1 : a.status) - (b.failed ? -1 : b.status)
    case 'method':
      return collator.compare(a.method, b.method)
    case 'domain':
      return collator.compare(a.host, b.host)
    case 'path':
      return collator.compare(a.path, b.path)
    case 'type':
      return collator.compare(a.type, b.type) || collator.compare(a.mimeType, b.mimeType)
    case 'initiator':
      return collator.compare(a.initiator, b.initiator)
    case 'transfer':
      return a.transferSize - b.transferSize
    case 'size':
      return a.resourceSize - b.resourceSize
    case 'time':
      return a.time - b.time
    case 'waterfall':
      return (Number.isFinite(a.start) ? a.start : 0) - (Number.isFinite(b.start) ? b.start : 0)
  }
}

/** Sorts indexes in place; ties and no sort keep file order. */
export function sortIndexes(indexes: number[], entries: Entry[], sort: Sort): number[] {
  if (!sort) return indexes.sort((a, b) => a - b)
  return indexes.sort((ia, ib) => compare(entries[ia], entries[ib], sort.key) * sort.dir || ia - ib)
}
