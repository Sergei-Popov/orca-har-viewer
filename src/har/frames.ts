// WebSocket frames as the viewer shows them: text frames as sent, binary frames decoded when their
// bytes are text by the same rule masking uses, so what is shown as text is what was masked.

import { decodeBase64, decodeText, isTextBody } from './body'
import type { HarWebSocketMessage } from './types'

/** A frame's text (null for binary that is not text), and its bytes when it is a binary frame. */
export type FrameText = { text: string | null; bytes: Uint8Array | null }

export function frameText(message: HarWebSocketMessage): FrameText {
  const data = typeof message.data === 'string' ? message.data : ''
  if (message.opcode === undefined || message.opcode === 1) return { text: data, bytes: null }
  if (message.opcode !== 2) return { text: null, bytes: null }
  const bytes = decodeBase64(data)
  // Not base64 after all: shown, and masked, as it is.
  if (!bytes) return { text: data, bytes: null }
  return { text: bytes.length && isTextBody(bytes, '') ? decodeText(bytes) : null, bytes }
}
