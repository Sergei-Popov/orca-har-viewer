// What the error screen says when a file cannot be opened: a message in Orca's language, and a
// detail line only when it adds something the message does not (where the JSON breaks).

import type { ReadResult } from './har/read'
import { ZipError } from './har/zip'
import { fill, type Strings } from './i18n'

export function readError(result: Extract<ReadResult, { ok: false }>, s: Strings): [string, string | undefined] {
  const at = result.line !== undefined ? fill(s.errorAt, { line: result.line, column: result.column ?? 1, message: result.message }) : undefined
  if (result.reason === 'empty') return [s.errorEmpty, undefined]
  return [result.reason === 'not-har' ? s.errorNotHar : s.errorNotJson, at]
}

/**
 * An archive that cannot be read. A ZipError's own text is English and says what the translated
 * message already says, so it goes to the log, not under the message.
 */
export function openError(error: unknown, s: Strings): [string, string | undefined] {
  if (error instanceof ZipError) return [zipMessage(error, s), undefined]
  return [s.errorZipDamaged, error instanceof Error ? error.message : String(error)]
}

function zipMessage(error: ZipError, s: Strings): string {
  switch (error.code) {
    case 'not-zip':
      return s.errorNotZip
    case 'no-har':
      return s.errorNoHar
    case 'too-large':
      return s.errorZipLarge
    case 'method':
      return s.errorZipMethod
    default:
      return s.errorZipDamaged
  }
}
