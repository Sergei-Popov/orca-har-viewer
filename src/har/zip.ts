// Playwright's .har.zip: `har.har` plus one file per body, which entries name in `content._file`
// and `postData._file`. Reads the ZIP's central directory and unpacks a file only when asked,
// through fflate's streaming inflater fed in slices, so a file cannot unpack past the size the
// archive declares for it.

import { Inflate } from '../../vendor/fflate/fflate.mjs'
import { decodeText, type SideFiles } from './body'

/** The most a single file of the archive may unpack to. */
export const MAX_UNPACKED = 256 * 1024 * 1024

/** The most the body files of one archive may unpack to together; files past it are not unpacked. */
export const MAX_TOTAL_UNPACKED = 512 * 1024 * 1024

/** Unpacked body files kept for reuse, in bytes; the least recently used are unpacked again. */
export const CACHE_BYTES = 64 * 1024 * 1024

export type ZipLimits = { total: number; cache: number }

export class ZipError extends Error {
  constructor(
    readonly code: 'not-zip' | 'no-har' | 'damaged' | 'too-large' | 'method',
    message: string
  ) {
    super(message)
    this.name = 'ZipError'
  }
}

type Item = { name: string; method: number; packed: number; size: number; header: number }

export type HarZip = {
  /** The HAR's own text. */
  text: string
  /** Its name inside the archive, usually `har.har`. */
  name: string
  files: SideFiles
  /** Every file name in the archive. */
  names: string[]
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5) && (bytes[3] === 4 || bytes[3] === 6)
}

export function openHarZip(bytes: Uint8Array, limits: ZipLimits = { total: MAX_TOTAL_UNPACKED, cache: CACHE_BYTES }): HarZip {
  const items = readDirectory(bytes)
  const byName = new Map(items.map((item) => [item.name, item]))
  const har =
    byName.get('har.har') ??
    items
      .filter((item) => item.name.toLowerCase().endsWith('.har'))
      .sort((a, b) => a.name.split('/').length - b.name.split('/').length || a.name.length - b.name.length)[0]
  if (!har) throw new ZipError('no-har', 'This ZIP holds no .har file.')
  const text = decodeText(unpack(bytes, har))
  // Most recently used last; `cached` is the bytes it holds.
  const cache = new Map<string, Uint8Array>()
  let cached = 0
  const failed = new Set<string>()
  const over = new Set<string>()
  // Files unpacked at least once, and what they unpacked to together.
  const counted = new Set<string>()
  let spent = 0
  const files: SideFiles = {
    has: (name) => byName.has(name),
    get(name) {
      const hit = cache.get(name)
      if (hit) {
        cache.delete(name)
        cache.set(name, hit)
        return hit
      }
      const item = byName.get(name)
      if (!item || failed.has(name) || over.has(name)) return null
      if (!counted.has(name) && spent + item.size > limits.total) {
        over.add(name)
        return null
      }
      let result: Uint8Array
      try {
        result = unpack(bytes, item)
      } catch {
        failed.add(name)
        return null
      }
      if (!counted.has(name)) {
        counted.add(name)
        spent += item.size
      }
      if (result.length <= limits.cache) {
        cache.set(name, result)
        cached += result.length
        for (const [oldest, value] of cache) {
          if (cached <= limits.cache) break
          cache.delete(oldest)
          cached -= value.length
        }
      }
      return result
    },
    overBudget: (name) => over.has(name)
  }
  return { text, name: har.name, files, names: items.map((item) => item.name) }
}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8)
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0
const u64 = (b: Uint8Array, at: number) => u32(b, at) + u32(b, at + 4) * 0x100000000

function readDirectory(bytes: Uint8Array): Item[] {
  if (!isZip(bytes)) throw new ZipError('not-zip', 'This file is not a ZIP archive.')
  let end = -1
  for (let at = bytes.length - 22; at >= 0 && at >= bytes.length - 22 - 0xffff; at--) {
    if (u32(bytes, at) === 0x06054b50) {
      end = at
      break
    }
  }
  if (end < 0) throw new ZipError('damaged', 'The ZIP has no central directory: it is cut off or damaged.')
  let count = u16(bytes, end + 10)
  let offset = u32(bytes, end + 16)
  if ((count === 0xffff || offset === 0xffffffff) && end >= 20 && u32(bytes, end - 20) === 0x07064b50) {
    const zip64 = u64(bytes, end - 12)
    if (zip64 + 56 <= bytes.length && u32(bytes, zip64) === 0x06064b50) {
      count = u64(bytes, zip64 + 32)
      offset = u64(bytes, zip64 + 48)
    }
  }
  const items: Item[] = []
  let at = offset
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || u32(bytes, at) !== 0x02014b50) {
      throw new ZipError('damaged', 'The ZIP directory is damaged.')
    }
    const method = u16(bytes, at + 10)
    let packed = u32(bytes, at + 20)
    let size = u32(bytes, at + 24)
    const nameLength = u16(bytes, at + 28)
    const extraLength = u16(bytes, at + 30)
    const commentLength = u16(bytes, at + 32)
    let header = u32(bytes, at + 42)
    const name = decodeText(bytes.subarray(at + 46, at + 46 + nameLength))
    // ZIP64 sizes and offset, in this order, for the fields set to 0xffffffff.
    let extra = at + 46 + nameLength
    const extraEnd = extra + extraLength
    while (extra + 4 <= extraEnd) {
      const id = u16(bytes, extra)
      const length = u16(bytes, extra + 2)
      if (id === 1) {
        let p = extra + 4
        if (size === 0xffffffff) (size = u64(bytes, p)), (p += 8)
        if (packed === 0xffffffff) (packed = u64(bytes, p)), (p += 8)
        if (header === 0xffffffff) header = u64(bytes, p)
      }
      extra += 4 + length
    }
    items.push({ name, method, packed, size, header })
    at = extraEnd + commentLength
  }
  return items
}

function unpack(bytes: Uint8Array, item: Item): Uint8Array {
  const at = item.header
  if (at + 30 > bytes.length || u32(bytes, at) !== 0x04034b50) {
    throw new ZipError('damaged', `The ZIP entry ${item.name} is damaged.`)
  }
  const start = at + 30 + u16(bytes, at + 26) + u16(bytes, at + 28)
  if (start + item.packed > bytes.length) throw new ZipError('damaged', `The ZIP entry ${item.name} is cut off.`)
  const data = bytes.subarray(start, start + item.packed)
  if (item.size > MAX_UNPACKED) throw new ZipError('too-large', `${item.name} unpacks to more than 256 MB.`)
  if (item.method === 0) return data
  if (item.method !== 8) throw new ZipError('method', `${item.name} uses ZIP method ${item.method}, which HAR Viewer cannot unpack.`)
  return inflate(data, item.size, item.name)
}

const SLICE = 1 << 16

/** Raw DEFLATE that must unpack to exactly `size` bytes; stops as soon as it would pass it. */
export function inflate(data: Uint8Array, size: number, name = 'data'): Uint8Array {
  const out = new Uint8Array(size)
  let length = 0
  let over = false
  const stream = new Inflate((chunk) => {
    if (over) return
    if (length + chunk.length > size) {
      over = true
      return
    }
    out.set(chunk, length)
    length += chunk.length
  })
  try {
    for (let at = 0; at < data.length && !over; at += SLICE) {
      const end = Math.min(data.length, at + SLICE)
      stream.push(data.subarray(at, end), end === data.length)
    }
  } catch {
    throw new ZipError('damaged', `${name} is damaged.`)
  }
  if (over || length !== size) throw new ZipError('damaged', `${name} does not unpack to the size the archive declares.`)
  return out
}
