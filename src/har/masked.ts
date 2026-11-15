// The masked view of a whole recording: the HAR from `sanitizeHar` plus, for a .har.zip, its
// text body files masked the same way, and the sanitized copy that "Save sanitized…" writes.

import { zipSync } from '../../vendor/fflate/fflate.mjs'
import { isMediaType, type SideFiles } from './body'
import { isOauthUrl } from './mask-url'
import { sanitizeHar, sanitizeSideFile, type Counter, type SanitizeReport } from './sanitize'
import type { Har, HarEntry } from './types'

export type Masked = { har: Har; report: SanitizeReport; files?: SideFiles }

/** Body files an entry points to, with the MIME type that tells how to read them. */
function fileRefs(entry: HarEntry): { name: string; mimeType: string }[] {
  const refs: { name: string; mimeType: string }[] = []
  const content = entry.response?.content
  if (content && typeof content._file === 'string' && content._file) {
    refs.push({ name: content._file, mimeType: typeof content.mimeType === 'string' ? content.mimeType : '' })
  }
  const post = entry.request?.postData
  if (post && typeof post._file === 'string' && post._file) {
    refs.push({ name: post._file, mimeType: typeof post.mimeType === 'string' ? post.mimeType : '' })
  }
  return refs
}

/**
 * Masks the HAR and, when the body files are at hand, every body file the viewer would show as
 * text (by the same rule as inline bodies). Binary files pass through unchanged. The input is
 * never changed.
 */
export function maskRecording(har: Har, files?: SideFiles): Masked {
  const { har: masked, report } = sanitizeHar(har)
  if (!files) return { har: masked, report }
  const replaced = new Map<string, Uint8Array>()
  const entries = har.log.entries ?? []
  entries.forEach((entry, index) => {
    const counter: Counter = {
      add(kind, count = 1) {
        report[kind] += count
        report.total += count
        report.entries.add(index)
      }
    }
    const oauth = typeof entry.request?.url === 'string' && isOauthUrl(entry.request.url)
    for (const ref of fileRefs(entry)) {
      // Images, audio, video and fonts are never text, so they need not even be unpacked.
      if (replaced.has(ref.name) || isMediaType(ref.mimeType) || !files.has(ref.name)) continue
      const bytes = files.get(ref.name)
      if (!bytes) continue
      const out = sanitizeSideFile(bytes, ref.mimeType, counter, { oauth })
      if (out !== bytes) replaced.set(ref.name, out)
    }
  })
  return {
    har: masked,
    report,
    files: {
      has: (name) => files.has(name),
      get: (name) => replaced.get(name) ?? files.get(name),
      overBudget: (name) => !!files.overBudget?.(name)
    }
  }
}

/** The masked HAR as text, two-space indented like the files browsers write. */
export function maskedHarText(masked: Masked): string {
  return JSON.stringify(masked.har, null, 2)
}

/**
 * A sanitized .har.zip: `har.har` and the body files its entries point to (masked text, binary
 * unchanged). Files nothing points to are left out, as they could hold anything, and so are files
 * that could not be unpacked (past the archive's unpack budget): they could not be masked.
 */
export function maskedHarZip(masked: Masked): Uint8Array {
  const contents: Record<string, Uint8Array | [Uint8Array, { level?: number }]> = {
    'har.har': [new TextEncoder().encode(maskedHarText(masked)), { level: 6 }]
  }
  if (masked.files) {
    for (const entry of masked.har.log.entries ?? []) {
      for (const ref of fileRefs(entry)) {
        if (ref.name in contents || ref.name === 'har.har') continue
        const bytes = masked.files.get(ref.name)
        // Already-compressed media gains nothing from deflate.
        if (bytes) contents[ref.name] = [bytes, { level: isMediaType(ref.mimeType) ? 0 : 6 }]
      }
    }
  }
  return zipSync(contents)
}
