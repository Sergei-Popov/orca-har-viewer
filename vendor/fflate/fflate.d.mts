// The parts of fflate 0.8.3 (MIT, https://github.com/101arrowz/fflate) HAR Viewer uses.
export type FlateStreamHandler = (data: Uint8Array, final: boolean) => void
export declare class Inflate {
  constructor(cb?: FlateStreamHandler)
  ondata: FlateStreamHandler
  push(chunk: Uint8Array, final?: boolean): void
}
export declare function zipSync(
  data: Record<string, Uint8Array | [Uint8Array, { level?: number }]>,
  opts?: { level?: number; mtime?: number | Date }
): Uint8Array
export type ZipStreamHandler = (error: Error | null, data: Uint8Array, final: boolean) => void
export declare class ZipPassThrough {
  constructor(filename: string)
  push(chunk: Uint8Array, final?: boolean): void
}
export declare class ZipDeflate extends ZipPassThrough {
  constructor(filename: string, opts?: { level?: number })
}
export declare class Zip {
  constructor(cb?: ZipStreamHandler)
  add(file: ZipPassThrough): void
  end(): void
}
