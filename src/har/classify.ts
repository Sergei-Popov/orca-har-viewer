// Resource types for the filter chips, as DevTools groups them: Chrome's `_resourceType` when the
// file has it, else Sec-Fetch-Dest, the MIME type and the URL's extension.

import type { HarEntry } from './types'

export type ResourceType = 'fetch' | 'doc' | 'js' | 'css' | 'img' | 'font' | 'media' | 'ws' | 'wasm' | 'other'

/** Chip order. */
export const RESOURCE_TYPES: ResourceType[] = ['fetch', 'doc', 'js', 'css', 'img', 'font', 'media', 'ws', 'wasm', 'other']

const CHROME_TYPES: Record<string, ResourceType> = {
  xhr: 'fetch',
  fetch: 'fetch',
  eventsource: 'fetch',
  document: 'doc',
  script: 'js',
  stylesheet: 'css',
  image: 'img',
  font: 'font',
  media: 'media',
  websocket: 'ws',
  wasm: 'wasm',
  webassembly: 'wasm'
}

const DEST_TYPES: Record<string, ResourceType> = {
  document: 'doc',
  iframe: 'doc',
  frame: 'doc',
  script: 'js',
  worker: 'js',
  sharedworker: 'js',
  serviceworker: 'js',
  audioworklet: 'js',
  paintworklet: 'js',
  style: 'css',
  image: 'img',
  font: 'font',
  audio: 'media',
  video: 'media',
  track: 'media',
  empty: 'fetch'
}

const EXTENSION_TYPES: Record<string, ResourceType> = {
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  css: 'css',
  html: 'doc',
  htm: 'doc',
  png: 'img',
  jpg: 'img',
  jpeg: 'img',
  gif: 'img',
  webp: 'img',
  avif: 'img',
  svg: 'img',
  ico: 'img',
  bmp: 'img',
  woff: 'font',
  woff2: 'font',
  ttf: 'font',
  otf: 'font',
  eot: 'font',
  mp4: 'media',
  webm: 'media',
  mp3: 'media',
  m4a: 'media',
  ogg: 'media',
  wav: 'media',
  m3u8: 'media',
  mpd: 'media',
  ts: 'media',
  wasm: 'wasm'
}

export function classify(raw: HarEntry, scheme: string, path: string, mimeType: string): ResourceType {
  const chrome = typeof raw._resourceType === 'string' ? raw._resourceType.toLowerCase() : ''
  if (chrome === 'websocket') return 'ws'
  if (scheme === 'ws' || scheme === 'wss' || Array.isArray(raw._webSocketMessages)) return 'ws'
  if (mimeType === 'application/wasm') return 'wasm'
  if (chrome && CHROME_TYPES[chrome]) return CHROME_TYPES[chrome]
  if (chrome) return 'other'
  const headers = raw.request?.headers
  let dest = ''
  let upgrade = ''
  let requestedWith = ''
  if (Array.isArray(headers)) {
    for (const header of headers) {
      const name = typeof header?.name === 'string' ? header.name.toLowerCase() : ''
      if (name === 'sec-fetch-dest') dest = String(header.value).toLowerCase()
      else if (name === 'upgrade') upgrade = String(header.value).toLowerCase()
      else if (name === 'x-requested-with') requestedWith = String(header.value).toLowerCase()
    }
  }
  if (upgrade === 'websocket') return 'ws'
  const extension = extensionOf(path)
  if (extension === 'wasm') return 'wasm'
  if (dest && DEST_TYPES[dest]) return DEST_TYPES[dest]
  if (requestedWith === 'xmlhttprequest') return 'fetch'
  const byMime = mimeTypeKind(mimeType)
  if (byMime) return byMime
  if (EXTENSION_TYPES[extension]) return EXTENSION_TYPES[extension]
  return 'other'
}

function mimeTypeKind(mime: string): ResourceType | null {
  if (!mime) return null
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'doc'
  if (mime.includes('javascript') || mime.includes('ecmascript')) return 'js'
  if (mime === 'text/css') return 'css'
  if (mime.startsWith('image/')) return 'img'
  if (mime.startsWith('font/') || mime.includes('font') || mime === 'application/vnd.ms-fontobject') return 'font'
  if (mime.startsWith('audio/') || mime.startsWith('video/') || mime === 'application/ogg' || mime.includes('mpegurl') || mime === 'application/dash+xml') {
    return 'media'
  }
  if (mime.includes('json') || mime === 'text/event-stream' || mime === 'application/x-www-form-urlencoded') return 'fetch'
  return null
}

function extensionOf(path: string): string {
  const clean = path.split(/[?#]/)[0]
  const slash = clean.lastIndexOf('/')
  const dot = clean.lastIndexOf('.')
  return dot > slash ? clean.slice(dot + 1).toLowerCase() : ''
}
