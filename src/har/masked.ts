// The masked view of a whole recording: the HAR from `sanitizeHar` plus, for a .har.zip, its
// text body files masked the same way, and the sanitized copy that "Save sanitized…" writes.
// Both come in steps (generators that yield their progress), so a large recording can be masked
// and packed in slices that let the page paint, or all at once.

import { Zip, ZipDeflate, ZipPassThrough } from '../../vendor/fflate/fflate.mjs'
import { isMediaType, type SideFiles } from './body'
import { MASK } from './mask-text'
import { isOauthUrl } from './mask-url'
import { emptyReport, recordingIds, sanitizeSideFile, sanitizeSteps, type Counter, type SanitizeReport } from './sanitize'
import type { Har, HarEntry } from './types'

export type Masked = { har: Har; report: SanitizeReport; files?: SideFiles }

/** Work done so far, from 0 to 1. */
export type Steps<T> = Generator<number, T>

/** Runs steps to the end at once. */
export function runSteps<T>(steps: Steps<T>): T {
  for (;;) {
    const next = steps.next()
    if (next.done) return next.value
  }
}

/** Runs steps in slices of about `slice` ms, letting the page paint and reporting progress between them. */
export async function runStepsAsync<T>(steps: Steps<T>, progress?: (done: number) => void, slice = 40): Promise<T> {
  let since = performance.now()
  for (;;) {
    const next = steps.next()
    if (next.done) return next.value
    if (performance.now() - since >= slice) {
      progress?.(next.value)
      await new Promise((resolve) => setTimeout(resolve, 0))
      since = performance.now()
    }
  }
}

/** Body files an entry points to, with the MIME type that tells how to read them. */
function fileRefs(entry: HarEntry): { name: string; mimeType: string }[] {
  const refs: { name: string; mimeType: string }[] = []
  const content = entry?.response?.content
  if (content && typeof content._file === 'string' && content._file) {
    refs.push({ name: content._file, mimeType: typeof content.mimeType === 'string' ? content.mimeType : '' })
  }
  const post = entry?.request?.postData
  if (post && typeof post._file === 'string' && post._file) {
    refs.push({ name: post._file, mimeType: typeof post.mimeType === 'string' ? post.mimeType : '' })
  }
  return refs
}

const MASKED_FILE = new TextEncoder().encode(MASK)

/** Bytes of the text body files a recording's entries point to, as the archive declares them. */
function textFileBytes(har: Har, files?: SideFiles): number {
  let bytes = 0
  if (!files) return bytes
  const seen = new Set<string>()
  for (const entry of Array.isArray(har.log.entries) ? har.log.entries : []) {
    for (const ref of fileRefs(entry)) {
      if (seen.has(ref.name) || isMediaType(ref.mimeType) || !files.has(ref.name)) continue
      seen.add(ref.name)
      bytes += files.size?.(ref.name) ?? 0
    }
  }
  return bytes
}

/**
 * About how much text masking a recording reads, in bytes: the inline bodies and frames, a
 * little for every entry's headers and URL, and the text body files. Tells whether masking (or
 * building the copy) takes long enough to run in slices with progress.
 */
export function maskingWeight(har: Har, files?: SideFiles): number {
  let bytes = textFileBytes(har, files)
  const size = (value: unknown) => (typeof value === 'string' ? value.length : 0)
  for (const entry of Array.isArray(har.log.entries) ? har.log.entries : []) {
    bytes += 1024 + size(entry?.response?.content?.text) + size(entry?.request?.postData?.text)
    const frames = entry?._webSocketMessages
    if (Array.isArray(frames)) for (const frame of frames) bytes += 64 + size(frame?.data)
  }
  return bytes
}

/**
 * Masks the HAR and, when the body files are at hand, every body file the viewer would show as
 * text (by the same rule as inline bodies). Binary files pass through unchanged. A file that
 * cannot be masked is replaced with `[masked]` and its request is reported as failed. The input
 * is never changed.
 */
export function maskRecording(har: Har, files?: SideFiles): Masked {
  return runSteps(maskSteps(har, files))
}

/**
 * `maskRecording` in steps: the body files first, then the entries, so identifiers the files'
 * JSON keeps under their names (`"id": "ord_8f2a…"`) are known when the URLs are masked.
 */
export function* maskSteps(har: Har, files?: SideFiles): Steps<Masked> {
  const fileBytes = textFileBytes(har, files)
  // Body files and entries share the progress by what there is of each.
  const fileShare = files && fileBytes ? 0.7 : 0
  const report = emptyReport()
  const ids = recordingIds(har)
  const replaced = new Map<string, Uint8Array>()
  if (files) {
    const entries = Array.isArray(har.log.entries) ? har.log.entries : []
    let done = 0
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]
      const counter: Counter = {
        add(kind, count = 1) {
          report[kind] += count
          report.total += count
          report.entries.add(index)
        },
        ids
      }
      const oauth = typeof entry?.request?.url === 'string' && isOauthUrl(entry.request.url)
      for (const ref of fileRefs(entry)) {
        // Images, audio, video and fonts are never text, so they need not even be unpacked.
        if (replaced.has(ref.name) || isMediaType(ref.mimeType) || !files.has(ref.name)) continue
        const bytes = files.get(ref.name)
        if (!bytes) continue
        try {
          const out = sanitizeSideFile(bytes, ref.mimeType, counter, { oauth })
          if (out !== bytes) replaced.set(ref.name, out)
        } catch {
          // Never shown or saved unmasked: the file is replaced and the request reported.
          replaced.set(ref.name, MASKED_FILE)
          report.failed.add(index)
          report.entries.add(index)
        }
        done += files.size?.(ref.name) ?? bytes.length
        yield fileShare * Math.min(1, done / Math.max(1, fileBytes))
      }
    }
  }
  const sanitize = sanitizeSteps(har, { report, ids })
  let step = sanitize.next()
  while (!step.done) {
    yield fileShare + step.value * (1 - fileShare)
    step = sanitize.next()
  }
  const masked = step.value.har
  if (!files) return { har: masked, report }
  return {
    har: masked,
    report,
    files: {
      has: (name) => files.has(name),
      get: (name) => replaced.get(name) ?? files.get(name),
      problem: (name) => files.problem?.(name) ?? null,
      size: (name) => replaced.get(name)?.length ?? files.size?.(name) ?? 0
    }
  }
}

/** The masked HAR as text: two-space indented like the files browsers write, or minified like its source. */
export function maskedHarText(masked: Masked, compact = false): string {
  return compact ? JSON.stringify(masked.har) : JSON.stringify(masked.har, null, 2)
}

/**
 * The masked HAR as the bytes of a .har file: formatted like its source, and minified anyway when
 * the indented text would be over `limit` (indenting nearly doubles a minified recording).
 */
export function maskedHarBytes(masked: Masked, compact: boolean, limit: number): Uint8Array {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(maskedHarText(masked, compact))
  return bytes.length > limit && !compact ? encoder.encode(maskedHarText(masked, true)) : bytes
}

/**
 * A sanitized .har.zip: `har.har` and the body files its entries point to (masked text, binary
 * unchanged). Files nothing points to are left out, as they could hold anything, and so are files
 * that could not be unpacked (past the archive's unpack budget, too large or damaged): they could
 * not be masked.
 */
export function maskedHarZip(masked: Masked, compact = false): Uint8Array {
  return runSteps(maskedHarZipSteps(masked, compact))
}

/** Bytes deflated between two progress reports. */
const ZIP_SLICE = 1 << 20

/** `maskedHarZip` in steps, file by file and a megabyte at a time. */
export function* maskedHarZipSteps(masked: Masked, compact = false): Steps<Uint8Array> {
  const contents: { name: string; bytes: Uint8Array; level: number }[] = [
    { name: 'har.har', bytes: new TextEncoder().encode(maskedHarText(masked, compact)), level: 6 }
  ]
  if (masked.files) {
    const names = new Set(['har.har'])
    for (const entry of Array.isArray(masked.har.log.entries) ? masked.har.log.entries : []) {
      for (const ref of fileRefs(entry)) {
        if (names.has(ref.name)) continue
        const bytes = masked.files.get(ref.name)
        if (!bytes) continue
        names.add(ref.name)
        // Already-compressed media gains nothing from deflate.
        contents.push({ name: ref.name, bytes, level: isMediaType(ref.mimeType) ? 0 : 6 })
      }
    }
  }
  const total = contents.reduce((sum, file) => sum + file.bytes.length, 0)
  const chunks: Uint8Array[] = []
  let failure: Error | null = null
  const zip = new Zip((error, chunk) => {
    if (error) failure = error
    else chunks.push(chunk)
  })
  let done = 0
  for (const file of contents) {
    const stream = file.level ? new ZipDeflate(file.name, { level: file.level }) : new ZipPassThrough(file.name)
    zip.add(stream)
    if (!file.bytes.length) stream.push(file.bytes, true)
    for (let at = 0; at < file.bytes.length; at += ZIP_SLICE) {
      const end = Math.min(file.bytes.length, at + ZIP_SLICE)
      stream.push(file.bytes.subarray(at, end), end === file.bytes.length)
      if (failure) throw failure
      done += end - at
      yield done / Math.max(1, total)
    }
  }
  zip.end()
  if (failure) throw failure
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}
