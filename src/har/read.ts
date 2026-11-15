// Text → HAR. A valid file goes through JSON.parse; a cut-off or damaged one is scanned for the
// entries and pages that are still whole, so the viewer can show what could be read.

import type { Har, HarCreator, HarEntry, HarLog, HarPage } from './types'

export type ReadIssue = {
  /** `truncated`: the text ends before the JSON does; `invalid`: it breaks somewhere earlier. */
  kind: 'truncated' | 'invalid'
  /** JSON.parse's message. */
  message: string
  line: number
  column: number
  /** Entries that were whole and could be read. */
  recovered: number
  /** Entries that were cut or broken and were left out. */
  skipped: number
}

export type ReadResult =
  | { ok: true; har: Har; issue?: ReadIssue }
  | { ok: false; reason: 'empty' | 'not-json' | 'not-har'; message: string; line?: number; column?: number }

/** Reads HAR text. Never throws. */
export function readHar(input: string): ReadResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  if (!text.trim()) return { ok: false, reason: 'empty', message: 'The file is empty.' }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return recover(text, error instanceof Error ? error.message : String(error))
  }
  const har = asHar(value)
  if (!har) {
    return { ok: false, reason: 'not-har', message: 'This JSON has no log.entries: it is not an HTTP Archive.' }
  }
  return { ok: true, har }
}

/** Accepts `{ log: { entries } }`, and leniently `{ entries }` or a bare array of entries. */
export function asHar(value: unknown): Har | null {
  if (Array.isArray(value)) return value.every(isObject) ? { log: { entries: value as HarEntry[] } } : null
  if (!isObject(value)) return null
  const log = isObject(value.log) ? value.log : Array.isArray(value.entries) ? value : null
  if (!log || !Array.isArray(log.entries)) return null
  const entries = (log.entries as unknown[]).filter(isObject) as HarEntry[]
  const pages = Array.isArray(log.pages) ? ((log.pages as unknown[]).filter(isObject) as HarPage[]) : undefined
  return { log: { ...(log as HarLog), entries, pages } }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Where JSON.parse stopped, from its message ("… at position 123 …"); the end when it ran out; -1 when it does not say. */
export function errorOffset(message: string, length: number): number {
  const match = /position (\d+)/.exec(message)
  if (match) return Math.min(Number(match[1]), length)
  return /end of (JSON )?input/i.test(message) ? length : -1
}

export function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) {
    line++
    lineStart = i + 1
  }
  return { line, column: offset - lineStart + 1 }
}

const OPEN_OBJECT = 0x7b
const CLOSE_OBJECT = 0x7d
const OPEN_ARRAY = 0x5b
const CLOSE_ARRAY = 0x5d
const QUOTE = 0x22
const BACKSLASH = 0x5c
const COMMA = 0x2c
const COLON = 0x3a

type Frame = {
  array: boolean
  /** The key of the value being read (objects), or null. */
  key: string | null
  expectKey: boolean
  /** Path of this container from the root, e.g. "log.entries". */
  path: string
  /** Where the element being collected starts, or -1. */
  valueStart: number
}

const LOG_KEYS = new Set(['creator', 'browser', 'version', 'comment'])

/** Whether the value being read in `frame` is one recovery parses on its own. */
function wanted(frame: Frame | undefined): frame is Frame {
  if (!frame) return false
  if (frame.path === 'log.entries' || frame.path === 'log.pages') return frame.array
  return frame.path === 'log' && !frame.array && frame.key !== null && LOG_KEYS.has(frame.key)
}

/**
 * Walks the text once, tracking strings and nesting, and parses each element of `log.entries`
 * and `log.pages` (and `log.creator`, `log.browser`, `log.version`) on its own as soon as it
 * closes. Whatever is cut or broken is skipped; the walk survives a broken element as long as
 * its brackets and quotes still balance.
 */
function recover(text: string, message: string): ReadResult {
  let offset = errorOffset(message, text.length)
  // No position given: plain text fails at its first character, JSON at its end.
  if (offset < 0) offset = /^\s*[[{]/.test(text) ? text.length : Math.max(0, text.search(/\S/))
  const where = lineColumn(text, offset)
  const entries: HarEntry[] = []
  const pages: HarPage[] = []
  const log: HarLog = {}
  let skipped = 0
  let sawLog = false
  const stack: Frame[] = []
  const n = text.length
  let i = 0

  const collect = (frame: Frame, end: number) => {
    const slice = text.slice(frame.valueStart, end)
    frame.valueStart = -1
    let value: unknown
    try {
      value = JSON.parse(slice)
    } catch {
      if (frame.path === 'log.entries') skipped++
      return
    }
    if (frame.path === 'log.entries') {
      if (isObject(value)) entries.push(value as HarEntry)
      else skipped++
    } else if (frame.path === 'log.pages') {
      if (isObject(value)) pages.push(value as HarPage)
    } else if (frame.key === 'creator' && isObject(value)) log.creator = value as HarCreator
    else if (frame.key === 'browser' && isObject(value)) log.browser = value as HarCreator
    else if (frame.key === 'version' && typeof value === 'string') log.version = value
    else if (frame.key === 'comment' && typeof value === 'string') log.comment = value
  }

  while (i < n) {
    const c = text.charCodeAt(i)
    const top = stack[stack.length - 1] as Frame | undefined
    if (c === QUOTE) {
      const start = i
      i = stringEnd(text, i + 1)
      if (top && !top.array && top.expectKey) {
        top.key = text.slice(start + 1, Math.max(start + 1, i - 1))
        top.expectKey = false
      } else if (wanted(top) && top.valueStart < 0) {
        top.valueStart = start
        collect(top, i)
      }
      continue
    }
    if (c === OPEN_OBJECT || c === OPEN_ARRAY) {
      if (wanted(top) && top.valueStart < 0) top.valueStart = i
      const path = !top ? '' : top.array ? `${top.path}[]` : top.path ? `${top.path}.${top.key ?? ''}` : (top.key ?? '')
      if (path === 'log' && c === OPEN_OBJECT) sawLog = true
      stack.push({ array: c === OPEN_ARRAY, key: null, expectKey: c === OPEN_OBJECT, path, valueStart: -1 })
      i++
      continue
    }
    if (c === CLOSE_OBJECT || c === CLOSE_ARRAY) {
      stack.pop()
      const parent = stack[stack.length - 1]
      if (wanted(parent) && parent.valueStart >= 0) collect(parent, i + 1)
      i++
      continue
    }
    if (c === COMMA) {
      if (top && !top.array) top.expectKey = true
      i++
      continue
    }
    if (c === COLON || c <= 0x20) {
      i++
      continue
    }
    // A number, true, false or null.
    const start = i
    while (i < n) {
      const d = text.charCodeAt(i)
      if (d === COMMA || d === CLOSE_OBJECT || d === CLOSE_ARRAY || d === OPEN_OBJECT || d === OPEN_ARRAY || d === QUOTE || d === COLON || d <= 0x20) break
      i++
    }
    if (i === start) i++
    if (wanted(top) && top.valueStart < 0) {
      top.valueStart = start
      collect(top, i)
    }
  }
  // An entry the text ends inside of.
  for (const frame of stack) if (frame.path === 'log.entries' && frame.valueStart >= 0) skipped++

  if (entries.length === 0 && !sawLog) {
    const looksJson = /^\s*[[{]/.test(text)
    return {
      ok: false,
      reason: looksJson ? 'not-har' : 'not-json',
      message: plainMessage(message),
      ...where
    }
  }
  const kind = offset >= text.trimEnd().length ? 'truncated' : 'invalid'
  return {
    ok: true,
    har: { log: { ...log, pages, entries } },
    issue: { kind, message: plainMessage(message), line: where.line, column: where.column, recovered: entries.length, skipped }
  }
}

/** JSON.parse's message without the position, which the caller reports as a line and column. */
export function plainMessage(message: string): string {
  return message.replace(/\s*(?:in JSON )?at position \d+(?:\s*\(line \d+ column \d+\))?/, '').trim()
}

/** Index just past the string that starts after the opening quote at `from - 1`. */
function stringEnd(text: string, from: number): number {
  let i = from
  for (;;) {
    const quote = text.indexOf('"', i)
    if (quote < 0) return text.length
    let backslashes = 0
    for (let j = quote - 1; j >= from && text.charCodeAt(j) === BACKSLASH; j--) backslashes++
    if (backslashes % 2 === 0) return quote + 1
    i = quote + 1
  }
}
