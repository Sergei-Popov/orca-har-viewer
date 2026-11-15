// "Export for agent": a compact Markdown digest of chosen requests for a coding agent to read.
// Callers pass entries of the masked HAR, so the digest never holds secrets; bodies are cut.

import { EN_UNITS, dateTime, formatBytes, formatMs } from '../format'
import { requestBody, responseBody, viewKind, type Body, type SideFiles } from './body'
import { reindentJson } from './json-text'
import type { Entry, Model } from './model'
import type { HarNameValue } from './types'

export type DigestOptions = {
  /** "3 failed requests". */
  title: string
  /** Include request and response bodies. */
  bodies: boolean
  /** Characters kept of each body. */
  maxBody?: number
  files?: SideFiles
}

/** Request headers browsers add to everything, left out to keep the digest short. */
const NOISY_REQUEST = new Set([
  'accept-encoding',
  'accept-language',
  'cache-control',
  'connection',
  'dnt',
  'pragma',
  'priority',
  'upgrade-insecure-requests',
  'user-agent'
])
const NOISY_RESPONSE = new Set([
  'accept-ranges',
  'alt-svc',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'date',
  'expect-ct',
  'nel',
  'permissions-policy',
  'referrer-policy',
  'report-to',
  'reporting-endpoints',
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
  'x-xss-protection'
])

export const DIGEST_MAX_BODY = 2000
const MAX_MESSAGES = 20

export function buildDigest(model: Model, entries: Entry[], options: DigestOptions): string {
  const maxBody = options.maxBody ?? DIGEST_MAX_BODY
  const lines: string[] = [`# HAR digest: ${options.title}`, '']
  const count = model.entries.length
  const source = [model.creator || 'unknown tool', `${count.toLocaleString('en')} ${count === 1 ? 'request' : 'requests'} in the file`]
  if (model.pages.length === 1) source.push(`page "${model.pages[0].title}"`)
  else if (model.pages.length > 1) source.push(`${model.pages.length} pages`)
  lines.push(`- Source: ${source.join(' · ')}`)
  if (model.start) lines.push(`- Recorded: ${dateTime(model.start)}`)
  lines.push(
    `- Known secret patterns are masked as \`[masked]\`; values with no known pattern are not, so review before sharing.${options.bodies ? ` Bodies are cut to ${maxBody.toLocaleString('en')} characters.` : ' Bodies are left out.'} Times are from the first request.`,
    ''
  )
  if (!entries.length) {
    lines.push('No requests.', '')
    return lines.join('\n')
  }
  entries.forEach((entry, i) => {
    lines.push(...describe(model, entry, i + 1, options, maxBody), '')
  })
  return lines.join('\n')
}

function describe(model: Model, entry: Entry, n: number, options: DigestOptions, maxBody: number): string[] {
  const status = entry.failed
    ? `failed${entry.error ? ` (${entry.error})` : ''}`
    : `${entry.status}${entry.statusText ? ` ${entry.statusText}` : ''}`
  const out = [`## ${n}. ${entry.method} ${entry.url} → ${status}`, '']
  const facts: string[] = []
  facts.push(`Type: ${entry.type}${entry.mimeType ? ` (${entry.mimeType})` : ''}`)
  if (Number.isFinite(entry.start) && model.start) facts.push(`Started: +${formatMs(entry.start - model.start)}`)
  const wait = entry.timings.wait
  facts.push(`Time: ${formatMs(entry.time)}${wait > 0 ? ` (waiting for the server ${formatMs(wait)})` : ''}`)
  const sizes = [
    entry.cache ? `from ${entry.cache} cache` : entry.transferSize >= 0 ? `${formatBytes(entry.transferSize, EN_UNITS)} transferred` : '',
    entry.resourceSize >= 0 ? `${formatBytes(entry.resourceSize, EN_UNITS)} body` : ''
  ].filter(Boolean)
  if (sizes.length) facts.push(`Size: ${sizes.join(', ')}`)
  if (entry.initiator) facts.push(`Initiator: ${entry.initiator}${entry.initiatorType ? ` (${entry.initiatorType})` : ''}`)
  if (entry.raw.serverIPAddress) facts.push(`Server: ${entry.raw.serverIPAddress}`)
  if (entry.httpVersion) facts.push(`Protocol: ${entry.httpVersion}`)
  if (entry.error && !entry.failed) facts.push(`Error: ${entry.error}`)
  const location = entry.raw.response?.redirectURL
  if (location) facts.push(`Redirects to: ${location}`)
  out.push(...facts.map((fact) => `- ${fact}`), '')

  out.push(...headerBlock('Request headers', entry.raw.request?.headers, NOISY_REQUEST))
  if (options.bodies) out.push(...bodyBlock('Request body', requestBody(entry.raw, options.files), maxBody))
  if (!entry.failed) {
    out.push(...headerBlock('Response headers', entry.raw.response?.headers, NOISY_RESPONSE))
    if (options.bodies) out.push(...bodyBlock('Response body', responseBody(entry.raw, options.files), maxBody))
  }
  const messages = entry.raw._webSocketMessages
  if (Array.isArray(messages) && messages.length) {
    out.push(`WebSocket messages (${messages.length}${messages.length > MAX_MESSAGES ? `, first ${MAX_MESSAGES}` : ''}):`, '')
    out.push('```text')
    for (const message of messages.slice(0, MAX_MESSAGES)) {
      const arrow = message.type === 'send' ? '→' : '←'
      const data = typeof message.data === 'string' ? message.data : ''
      const text = message.opcode === 2 ? `<binary, ${data.length} base64 characters>` : cut(data.replace(/\s+/g, ' '), 300)
      out.push(`${arrow} ${text}`)
    }
    out.push('```', '')
  }
  while (out[out.length - 1] === '') out.pop()
  return out
}

function headerBlock(title: string, headers: HarNameValue[] | undefined, noisy: Set<string>): string[] {
  if (!Array.isArray(headers) || !headers.length) return []
  const kept: string[] = []
  let left = 0
  for (const header of headers) {
    if (!header || typeof header.name !== 'string') continue
    const name = header.name.toLowerCase()
    if (name.startsWith(':') || noisy.has(name) || name.startsWith('sec-ch-') || name.startsWith('sec-fetch-')) {
      left++
      continue
    }
    kept.push(`${header.name}: ${header.value}`)
  }
  if (!kept.length) return []
  return [`${title}${left ? ` (${left} routine ones left out)` : ''}:`, '', ...fence(kept.join('\n'), 'http'), '']
}

function bodyBlock(title: string, body: Body, maxBody: number): string[] {
  if (body.kind === 'none') {
    if (body.reason === 'external-file' || body.reason === 'missing-file') return [`${title}: in a separate file (${body.file}), not included.`, '']
    if (body.reason === 'over-budget') return [`${title}: in ${body.file}, not unpacked (the archive's bodies unpack to more than 512 MB together), not included.`, '']
    if (body.reason === 'too-large') return [`${title}: in ${body.file}, which unpacks to more than 256 MB, not included.`, '']
    if (body.reason === 'unreadable') return [`${title}: in ${body.file}, which is damaged or cannot be unpacked, not included.`, '']
    return []
  }
  const mime = body.mimeType || 'unknown type'
  if (body.kind === 'bytes') return [`${title}: binary (${mime}, ${formatBytes(body.size)}), not included.`, '']
  const kind = viewKind(body.mimeType, body.text)
  let text = body.text
  // Indented token by token, so 64-bit integers and every other value stay exactly as written.
  if (kind === 'json') text = reindentJson(text) ?? text
  const cutText = cut(text, maxBody)
  const language = { json: 'json', html: 'html', xml: 'xml', js: 'js', css: 'css' }[kind as string] ?? 'text'
  return [`${title} (${mime}, ${formatBytes(body.size)}):`, '', ...fence(cutText, language), '']
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const rest = text.length - max
  return `${text.slice(0, max)}\n… (${rest.toLocaleString('en')} more characters)`
}

/** A code fence longer than any run of backticks inside. */
function fence(text: string, language: string): string[] {
  let longest = 2
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  const marks = '`'.repeat(longest + 1)
  return [`${marks}${language}`, text, marks]
}
