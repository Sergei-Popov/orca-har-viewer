// "Copy as cURL" (bash) and "Copy as fetch" for one request, the way DevTools writes them.

import { requestBody, type SideFiles } from './body'
import type { HarEntry, HarNameValue } from './types'

/** Headers curl and fetch set themselves, or that HTTP/2 shows as pseudo-headers. */
const SKIP_CURL = new Set(['content-length', 'host', 'connection'])
/** The function the "Copy as fetch" snippet calls. */
const SNIPPET_CALL = 'fetch'

/** Headers a page's fetch call may not set. */
const FORBIDDEN_FETCH = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via'
])

function headersOf(entry: HarEntry): HarNameValue[] {
  const list = entry.request?.headers
  return Array.isArray(list) ? list.filter((h) => h && typeof h.name === 'string' && !h.name.startsWith(':')) : []
}

/** Quotes for bash: '…' when it is plain, $'…' with escapes when it has control characters. */
export function shellQuote(text: string): string {
  if (!/[\0-\x1f\x7f]/.test(text)) return `'${text.replace(/'/g, `'\\''`)}'`
  let out = "$'"
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (ch === '\\') out += '\\\\'
    else if (ch === "'") out += "\\'"
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += ch
  }
  return `${out}'`
}

export function toCurl(entry: HarEntry, files?: SideFiles): string {
  const request = entry.request ?? {}
  const method = (request.method ?? 'GET').toUpperCase()
  const parts = [`curl ${shellQuote(request.url ?? '')}`]
  const body = requestBody(entry, files)
  const hasBody = body.kind !== 'none'
  if (!(method === 'GET' && !hasBody) && !(method === 'POST' && hasBody)) parts.push(`-X ${shellQuote(method)}`)
  let compressed = false
  for (const header of headersOf(entry)) {
    const name = header.name.toLowerCase()
    if (SKIP_CURL.has(name)) continue
    if (name === 'accept-encoding') {
      compressed = /gzip|deflate|br|zstd/.test(String(header.value))
      continue
    }
    if (name === 'cookie') {
      parts.push(`-b ${shellQuote(String(header.value))}`)
      continue
    }
    parts.push(`-H ${shellQuote(`${header.name}: ${header.value}`)}`)
  }
  if (body.kind === 'text') parts.push(`--data-raw ${shellQuote(body.text)}`)
  else if (body.kind === 'bytes') parts.push(`--data-binary ${shellQuote(`@<${body.size} bytes of ${body.mimeType || 'binary data'}>`)}`)
  if (compressed) parts.push('--compressed')
  return parts.join(' \\\n  ')
}

export function toFetch(entry: HarEntry, files?: SideFiles): string {
  const request = entry.request ?? {}
  const method = (request.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = {}
  let referrer = ''
  let credentials: 'include' | 'omit' = 'omit'
  for (const header of headersOf(entry)) {
    const name = header.name.toLowerCase()
    if (name === 'referer') referrer = String(header.value)
    if (name === 'cookie') credentials = 'include'
    if (FORBIDDEN_FETCH.has(name) || name.startsWith('sec-') || name.startsWith('proxy-')) continue
    headers[name] = String(header.value)
  }
  const init: Record<string, unknown> = {}
  if (Object.keys(headers).length) init.headers = headers
  if (referrer) init.referrer = referrer
  const body = requestBody(entry, files)
  if (body.kind === 'text') init.body = body.text
  else if (body.kind === 'bytes') init.body = `<${body.size} bytes of ${body.mimeType || 'binary data'}>`
  else init.body = null
  init.method = method
  init.mode = 'cors'
  init.credentials = credentials
  // Only text for the clipboard: the viewer itself never makes a request.
  return `${SNIPPET_CALL}(${JSON.stringify(request.url ?? '')}, ${JSON.stringify(init, null, 2)});`
}
