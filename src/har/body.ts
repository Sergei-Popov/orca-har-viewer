// Request and response bodies: inline text, base64, or a file next to the HAR inside a Playwright
// .har.zip. Text types come back as text (decoded with the declared charset), the rest as bytes.

import type { HarContent, HarEntry, HarPostData } from './types'

/** Body files of a .har.zip, by name. */
export type SideFiles = {
  has(name: string): boolean
  get(name: string): Uint8Array | null
  /** Whether `get` gave null because the archive's bodies together unpack to too much. */
  overBudget?(name: string): boolean
}

export type Body =
  | { kind: 'none'; reason: 'empty' | 'not-recorded' | 'missing-file' | 'external-file' | 'over-budget'; file?: string }
  | { kind: 'text'; text: string; mimeType: string; size: number; base64: boolean; file?: string }
  | { kind: 'bytes'; bytes: Uint8Array; mimeType: string; size: number; file?: string }

export type ViewKind = 'json' | 'html' | 'xml' | 'js' | 'css' | 'text' | 'image' | 'audio' | 'video' | 'font' | 'binary'

export function responseBody(entry: HarEntry, files?: SideFiles): Body {
  const content: HarContent = entry.response?.content ?? {}
  const mimeType = typeof content.mimeType === 'string' ? content.mimeType : ''
  const declared = typeof content.size === 'number' ? content.size : -1
  return readBody(content.text, content.encoding, content._file, mimeType, declared, files)
}

export function requestBody(entry: HarEntry, files?: SideFiles): Body {
  const post: HarPostData | undefined = entry.request?.postData
  if (!post) return { kind: 'none', reason: 'empty' }
  const mimeType = typeof post.mimeType === 'string' ? post.mimeType : ''
  if (post.text === undefined && !post._file && Array.isArray(post.params) && post.params.length) {
    // Form fields only: rebuild the urlencoded text.
    const text = post.params
      .map((p) => `${encodeURIComponent(p.name ?? '')}=${encodeURIComponent(p.value ?? '')}`)
      .join('&')
    return { kind: 'text', text, mimeType: mimeType || 'application/x-www-form-urlencoded', size: text.length, base64: false }
  }
  return readBody(post.text, post.encoding, post._file, mimeType, -1, files)
}

function readBody(
  text: unknown,
  encoding: unknown,
  file: unknown,
  mimeType: string,
  declared: number,
  files: SideFiles | undefined
): Body {
  if (typeof file === 'string' && file) {
    if (!files) return { kind: 'none', reason: 'external-file', file }
    const bytes = files.get(file)
    if (!bytes) return { kind: 'none', reason: files.overBudget?.(file) ? 'over-budget' : 'missing-file', file }
    return fromBytes(bytes, mimeType, false, file)
  }
  if (typeof text !== 'string') return { kind: 'none', reason: declared === 0 ? 'empty' : 'not-recorded' }
  if (encoding === 'base64') {
    const bytes = decodeBase64(text)
    if (!bytes) return { kind: 'text', text, mimeType, size: text.length, base64: false }
    return fromBytes(bytes, mimeType, true)
  }
  if (!text) return { kind: 'none', reason: 'empty' }
  return { kind: 'text', text, mimeType, size: declared >= 0 ? declared : utf8Length(text), base64: false }
}

function fromBytes(bytes: Uint8Array, mimeType: string, base64: boolean, file?: string): Body {
  if (bytes.length === 0) return { kind: 'none', reason: 'empty', file }
  if (isTextBody(bytes, mimeType)) {
    return { kind: 'text', text: decodeText(bytes, charsetOf(mimeType)), mimeType, size: bytes.length, base64, file }
  }
  return { kind: 'bytes', bytes, mimeType, size: bytes.length, file }
}

/** Text of a body, for search and export; null for bytes and missing bodies. */
export function bodyText(body: Body): string | null {
  return body.kind === 'text' ? body.text : null
}

/**
 * The one rule for "is this body text", shared by the viewer and the sanitizer: a text type, or
 * any type but images, audio, video and fonts when the bytes are UTF-8 without control
 * characters. Whatever the viewer shows as text is masked as text.
 */
export function isTextBody(bytes: Uint8Array, mimeType: string): boolean {
  if (isTextual(mimeType)) return true
  if (isMediaType(mimeType)) return false
  return looksLikeText(bytes)
}

/** Images, audio, video and fonts: never shown or masked as text (SVG is XML, so it is text). */
export function isMediaType(mimeType: string): boolean {
  const mime = baseMime(mimeType)
  if (mime === 'image/svg+xml') return false
  return /^(?:image|audio|video|font)\//.test(mime) || mime.includes('font') || mime === 'application/ogg'
}

export function isTextual(mimeType: string): boolean {
  const mime = baseMime(mimeType)
  if (!mime) return false
  return (
    mime.startsWith('text/') ||
    mime.includes('json') ||
    mime.includes('xml') ||
    mime.includes('javascript') ||
    mime.includes('ecmascript') ||
    mime.includes('graphql') ||
    mime.includes('yaml') ||
    mime === 'application/x-www-form-urlencoded' ||
    mime === 'application/x-ndjson' ||
    mime === 'application/csp-report' ||
    mime === 'multipart/form-data' ||
    mime === 'application/x-sh'
  )
}

export function baseMime(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase()
}

export function charsetOf(mimeType: string): string {
  const match = /charset\s*=\s*"?([\w.:-]+)/i.exec(mimeType)
  return match ? match[1].toLowerCase() : 'utf-8'
}

export function decodeText(bytes: Uint8Array, charset = 'utf-8'): string {
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(charset)
  } catch {
    decoder = new TextDecoder('utf-8')
  }
  return decoder.decode(bytes)
}

/** Decodes standard or URL-safe base64, with or without padding and whitespace; null if invalid. */
export function decodeBase64(text: string): Uint8Array | null {
  let clean = text
  try {
    return binaryToBytes(atob(clean))
  } catch {
    clean = text.replace(/[\s]/g, '').replace(/-/g, '+').replace(/_/g, '/')
    while (clean.length % 4) clean += '='
    try {
      return binaryToBytes(atob(clean))
    } catch {
      return null
    }
  }
}

function binaryToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)))
  }
  return btoa(binary)
}

export function utf8Length(text: string): number {
  let length = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) length += 1
    else if (c < 0x800) length += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      length += 4
      i++
    } else length += 3
  }
  return length
}

/**
 * Valid UTF-8 without control characters other than tab, form feed and line breaks (the SignalR
 * record separator U+001E counts as text too), judged on all of the bytes.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]
    if (byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12 && byte !== 0x1e) return false
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/** How to show a body of this MIME type (and text, to spot JSON sent as text/plain). */
export function viewKind(mimeType: string, text?: string): ViewKind {
  const mime = baseMime(mimeType)
  if (mime.includes('json')) return 'json'
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime === 'image/svg+xml') return 'image'
  if (mime.includes('xml')) return 'xml'
  if (mime.includes('javascript') || mime.includes('ecmascript')) return 'js'
  if (mime === 'text/css') return 'css'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/') || mime === 'application/ogg') return 'video'
  if (mime.startsWith('font/') || mime.includes('font')) return 'font'
  if (text !== undefined) {
    const start = text.trimStart()[0]
    if ((start === '{' || start === '[') && parseJson(text) !== undefined) return 'json'
    if (start === '<') return /^\s*<(!doctype html|html)/i.test(text) ? 'html' : 'xml'
    return 'text'
  }
  if (isTextual(mime)) return 'text'
  return 'binary'
}

/** JSON.parse that returns undefined instead of throwing. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
