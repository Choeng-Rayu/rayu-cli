import { Writable } from 'stream'

type Options = { columns?: number; rows?: number; isTTY?: boolean }

/**
 * A Writable that accumulates Ink's render output as text.
 *
 * `columns`, `rows` and `isTTY` are only assigned when supplied, so a caller
 * that omits them gets Ink's own defaults (80x24, non-TTY) instead of a
 * fabricated terminal size.
 */
export class CaptureStream extends Writable {
  output = ''
  columns?: number
  rows?: number
  isTTY?: boolean

  constructor(options: Options = {}) {
    super()
    if (options.columns !== undefined) this.columns = options.columns
    if (options.rows !== undefined) this.rows = options.rows
    if (options.isTTY !== undefined) this.isTTY = options.isTTY
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    callback()
  }
}
