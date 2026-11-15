// What the Payload tab lists: query parameters and form fields, each value decoded exactly once
// from the raw strings. Recorders differ in what they write to `queryString` and `params`:
// Chrome writes them encoded, Firefox and Playwright decoded, so neither list can be decoded
// safely. The URL and the urlencoded body text are the same in every recorder.

import { baseMime } from './body'
import { isFormShaped } from './mask-body'
import type { HarEntry } from './types'

export type Fields = [string, string][]

/** A field's value as text: strings as they are, other types (which no recorder writes) as JSON. */
function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Query parameters from the URL itself (decoded once); the HAR's list as written when the URL has no query. */
export function queryFields(raw: HarEntry, url: string): Fields {
  const at = url.indexOf('?')
  const hash = url.indexOf('#')
  if (at >= 0 && (hash < 0 || at < hash)) {
    const out: Fields = []
    new URLSearchParams(url.slice(at + 1, hash > at ? hash : undefined)).forEach((value, name) => out.push([name, value]))
    if (out.length) return out
  }
  const list = raw.request?.queryString
  if (!Array.isArray(list)) return []
  return list.filter((q) => q && typeof q === 'object').map((q): [string, string] => [text(q.name), text(q.value)])
}

/**
 * Form fields: from the body text when it is urlencoded (decoded once), else the HAR's `params`
 * as written (multipart fields, or Playwright's fields of a body kept in a separate file). Null
 * when the body is not a form.
 */
export function formFields(raw: HarEntry): Fields | null {
  const post = raw.request?.postData
  if (!post || typeof post !== 'object') return null
  const mime = typeof post.mimeType === 'string' ? baseMime(post.mimeType) : ''
  if (typeof post.text === 'string' && post.text && (mime === 'application/x-www-form-urlencoded' || (!mime && isFormShaped(post.text)))) {
    const out: Fields = []
    new URLSearchParams(post.text).forEach((value, name) => out.push([name, value]))
    return out
  }
  if (!Array.isArray(post.params) || !post.params.length) return null
  return post.params
    .filter((p) => p && typeof p === 'object')
    .map((p): [string, string] => [
      text(p.name),
      typeof p.fileName === 'string' && p.fileName ? `${p.fileName}${typeof p.contentType === 'string' && p.contentType ? ` (${p.contentType})` : ''}` : text(p.value)
    ])
}
