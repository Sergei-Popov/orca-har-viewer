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

/** An RFC 9110 field name. Anything else is not a header (`:authority`, or a crafted `@file`). */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
/** What no header line may hold: a shell cuts an argument at NUL, and CR or LF split the header. */
const BREAKS = /[\0\r\n]/
/** Control characters: a URL never holds them raw, and pasted into a terminal they act. */
const CONTROLS = /[\0-\x1f\x7f]/

function headersOf(entry: HarEntry): HarNameValue[] {
  const list = entry.request?.headers
  return Array.isArray(list) ? list.filter((h) => h && typeof h.name === 'string' && TOKEN.test(h.name)) : []
}

/** Whether a URL can go on the clipboard as it is. */
export function safeUrl(url: string): boolean {
  return !CONTROLS.test(url)
}

/**
 * Whether a request can be copied as a command. The file decides the URL, the method and every
 * header, so a request whose URL holds control characters, whose method is not a token, or whose
 * header names or values hold NUL, CR or LF is refused as a whole: it is crafted or broken, and a
 * command built from part of it would send something else.
 */
export function copyable(entry: HarEntry): boolean {
  const request = entry.request ?? {}
  if (!safeUrl(String(request.url ?? ''))) return false
  if (!TOKEN.test(String(request.method || 'GET'))) return false
  const list = Array.isArray(request.headers) ? request.headers : []
  return list.every((h) => !h || (!BREAKS.test(String(h.name ?? '')) && !BREAKS.test(String(h.value ?? ''))))
}

/** What stands in for a body the command cannot carry. The `@` makes curl stop with "cannot read" rather than send another body. */
function placeholder(size: number, mimeType: string): string {
  const type = (mimeType.split(';')[0] ?? '').replace(/[^A-Za-z0-9.+/-]/g, '').replace(/\.{2,}/g, '.') || 'binary data'
  return `@<${size} bytes of ${type}, not included>`
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

/**
 * The request as a curl command for bash or zsh, or null when it cannot be copied safely (see
 * {@link copyable}). Every value from the file goes in as the parameter of an option (`--url`,
 * `-X`, `-H`, `-b`, `--data-raw`), which curl never reads as an option itself, so no argument is
 * left for `--` to guard.
 */
export function toCurl(entry: HarEntry, files?: SideFiles): string | null {
  if (!copyable(entry)) return null
  const request = entry.request ?? {}
  const method = (request.method || 'GET').toUpperCase()
  const parts = [`curl --url ${shellQuote(request.url ?? '')}`]
  const body = requestBody(entry, files)
  const hasBody = body.kind !== 'none'
  if (!(method === 'GET' && !hasBody) && !(method === 'POST' && hasBody)) parts.push(`-X ${shellQuote(method)}`)
  let compressed = false
  for (const header of headersOf(entry)) {
    const name = header.name.toLowerCase()
    const value = String(header.value ?? '')
    if (SKIP_CURL.has(name)) continue
    if (name === 'accept-encoding') {
      compressed = /gzip|deflate|br|zstd/.test(value)
      continue
    }
    // curl reads a -b value without '=' as the name of a cookie file.
    if (name === 'cookie' && value.includes('=')) {
      parts.push(`-b ${shellQuote(value)}`)
      continue
    }
    parts.push(`-H ${shellQuote(`${header.name}: ${value}`)}`)
  }
  // A shell cannot pass a NUL in an argument, so such a body is left out like a binary one.
  if (body.kind === 'text' && !body.text.includes('\0')) parts.push(`--data-raw ${shellQuote(body.text)}`)
  else if (body.kind === 'text') parts.push(`--data-binary ${shellQuote(placeholder(body.size, body.mimeType))}`)
  else if (body.kind === 'bytes') parts.push(`--data-binary ${shellQuote(placeholder(body.size, body.mimeType))}`)
  if (compressed) parts.push('--compressed')
  return parts.join(' \\\n  ')
}

/** The request as a fetch call, or null when it cannot be copied safely (see {@link copyable}). */
export function toFetch(entry: HarEntry, files?: SideFiles): string | null {
  if (!copyable(entry)) return null
  const request = entry.request ?? {}
  const method = (request.method || 'GET').toUpperCase()
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
  else if (body.kind === 'bytes') init.body = `<${body.size} bytes of ${body.mimeType || 'binary data'}, not included>`
  else init.body = null
  init.method = method
  init.mode = 'cors'
  init.credentials = credentials
  // Only text for the clipboard: the viewer itself never makes a request.
  return `${SNIPPET_CALL}(${JSON.stringify(request.url ?? '')}, ${JSON.stringify(init, null, 2)});`
}
