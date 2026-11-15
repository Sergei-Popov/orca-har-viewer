// Header parsing the details pane needs: Server-Timing, and cookies from Cookie and Set-Cookie
// headers for recordings that leave the HAR's own cookie lists empty.

import type { HarCookie, HarNameValue } from './types'

export type ServerTiming = { name: string; duration: number; description: string }

/** `db;dur=53.2;desc="Database", cache;desc=hit` → entries; -1 when there is no duration. */
export function parseServerTiming(value: string): ServerTiming[] {
  const out: ServerTiming[] = []
  for (const part of splitOutsideQuotes(value, ',')) {
    const [name, ...params] = splitOutsideQuotes(part, ';').map((p) => p.trim())
    if (!name) continue
    let duration = -1
    let description = ''
    for (const param of params) {
      const eq = param.indexOf('=')
      const key = (eq < 0 ? param : param.slice(0, eq)).trim().toLowerCase()
      const raw = eq < 0 ? '' : unquote(param.slice(eq + 1).trim())
      if (key === 'dur') {
        const n = Number(raw)
        if (Number.isFinite(n)) duration = n
      } else if (key === 'desc') description = raw
    }
    out.push({ name, duration, description })
  }
  return out
}

function splitOutsideQuotes(text: string, separator: string): string[] {
  const parts: string[] = []
  let quoted = false
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"' && text[i - 1] !== '\\') quoted = !quoted
    else if (c === separator && !quoted) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.filter((p) => p.trim())
}

function unquote(text: string): string {
  return text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"' ? text.slice(1, -1).replace(/\\(.)/g, (_, c: string) => c) : text
}

/** `a=1; b=2` → cookies. */
export function parseCookieHeader(value: string): HarCookie[] {
  return value
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=')
      return eq < 0 ? { name: '', value: part } : { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() }
    })
}

/**
 * Cookies folded into one Set-Cookie value with `, ` (as `Headers.get` and some recorders join
 * them): split before each `, name=`, not inside `Expires=Wed, 21 Oct 2026 …`. The comma stays
 * at the end of each piece, so joining them gives the value back.
 */
export function splitSetCookie(line: string): string[] {
  const out: string[] = []
  let start = 0
  for (let comma = line.indexOf(','); comma >= 0; comma = line.indexOf(',', comma + 1)) {
    if (/^,[ \t]*[^;,=\s]{1,256}=/.test(line.slice(comma, comma + 260))) {
      out.push(line.slice(start, comma + 1))
      start = comma + 1
    }
  }
  out.push(line.slice(start))
  return out
}

/** One Set-Cookie line → a cookie with its attributes. */
export function parseSetCookie(line: string): HarCookie {
  const [pair, ...attributes] = line.split(';')
  const eq = pair.indexOf('=')
  const cookie: HarCookie = eq < 0 ? { name: '', value: pair.trim() } : { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() }
  for (const attribute of attributes) {
    const at = attribute.indexOf('=')
    const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase()
    const value = at < 0 ? '' : attribute.slice(at + 1).trim()
    if (key === 'domain') cookie.domain = value
    else if (key === 'path') cookie.path = value
    else if (key === 'expires') cookie.expires = value
    else if (key === 'max-age') cookie.expires = cookie.expires ?? `max-age=${value}`
    else if (key === 'httponly') cookie.httpOnly = true
    else if (key === 'secure') cookie.secure = true
    else if (key === 'samesite') cookie.sameSite = value
  }
  return cookie
}

/** The HAR's cookie list, or the cookies its headers carry when the list is empty. */
export function requestCookies(cookies: HarCookie[] | undefined, headers: HarNameValue[] | undefined): HarCookie[] {
  if (Array.isArray(cookies) && cookies.length) return cookies
  const out: HarCookie[] = []
  if (!Array.isArray(headers)) return out
  for (const header of headers) {
    if (typeof header?.name === 'string' && header.name.toLowerCase() === 'cookie' && typeof header.value === 'string') out.push(...parseCookieHeader(header.value))
  }
  return out
}

export function responseCookies(cookies: HarCookie[] | undefined, headers: HarNameValue[] | undefined): HarCookie[] {
  if (Array.isArray(cookies) && cookies.length) return cookies
  const out: HarCookie[] = []
  if (!Array.isArray(headers)) return out
  for (const header of headers) {
    if (typeof header?.name !== 'string' || header.name.toLowerCase() !== 'set-cookie' || typeof header.value !== 'string') continue
    // Some recorders join several Set-Cookie headers with line breaks, others with `, `.
    for (const line of header.value.split('\n')) {
      for (const one of splitSetCookie(line)) {
        const cookie = one.trim().replace(/,$/, '')
        if (cookie) out.push(parseSetCookie(cookie))
      }
    }
  }
  return out
}
