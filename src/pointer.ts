/**
 * The pointer file.
 *
 * A repository tracked by LFS does not contain the large file. It contains a
 * few lines of text that name it, and those lines are what git stores, diffs
 * and merges. Everything else in this package exists to move the bytes those
 * lines point at.
 *
 * The format is specified exactly, and the exactness is the point: a pointer is
 * hashed by git like any other blob, so two implementations that disagree about
 * a trailing newline produce two different blobs for the same file. From
 * `docs/spec.md` in git-lfs:
 *
 * - `version` first, always, and it names the spec URL.
 * - Every other key sorted alphabetically after it.
 * - One key per line, key and value separated by a single space.
 * - `\n` line endings, and a trailing `\n` after the last line.
 * - Keys are `[a-z0-9.-]`, values contain no newline.
 * - Under 200 bytes for the required keys, which is what makes it safe to read
 *   a candidate blob into memory before deciding whether it is one.
 *
 * Reading is deliberately stricter than writing: anything that is not exactly a
 * pointer is not a pointer. A file that merely *starts* like one is a file, and
 * treating it as a pointer would replace somebody's content with a download.
 */

/** The only spec version there has been. */
export const POINTER_VERSION = 'https://git-lfs.github.com/spec/v1'

/**
 * The largest a pointer can be before it is certainly not one.
 *
 * The spec puts the required keys under 200 bytes; this leaves room for the
 * optional extensions and still refuses to read a gigabyte off disk to find out
 * it was a video file all along.
 */
export const MAX_POINTER_BYTES = 1024

export interface Pointer {
  /** `sha256:<64 hex>` as written, including the algorithm prefix. */
  oid: string
  /** The hash algorithm, split out because only `sha256` is understood. */
  algorithm: string
  /** The hex digest without its prefix. */
  hash: string
  /** Bytes of the real file, not of the pointer. */
  size: number
  /** Keys the spec does not define, kept in the order they must be written. */
  extras: Record<string, string>
}

/**
 * Read a pointer, or decide that this is not one.
 *
 * Returns null rather than throwing, because "is this a pointer" is a question
 * asked of every blob in a checkout and the answer is usually no.
 */
export function parsePointer(input: string | Uint8Array): Pointer | null {
  const text = typeof input === 'string' ? input : new TextDecoder().decode(input)

  // Length first: a pointer is small, and this is the cheap way to say no to
  // the file that is actually a video.
  if (text.length === 0 || text.length > MAX_POINTER_BYTES)
    return null

  // A pointer is text. A binary file that happens to be short is not one, and
  // a NUL byte is the cheapest proof that it is binary.
  if (text.includes('\0'))
    return null

  // The trailing newline is required, and the split below would otherwise
  // silently accept a file missing it.
  if (!text.endsWith('\n'))
    return null

  const lines = text.slice(0, -1).split('\n')
  if (lines.length < 3)
    return null

  const pairs: Array<[string, string]> = []

  for (const line of lines) {
    // Exactly one space separates key from value, so the value may contain
    // spaces and the key may not.
    const space = line.indexOf(' ')
    if (space <= 0)
      return null

    const key = line.slice(0, space)
    const value = line.slice(space + 1)

    if (!/^[a-z0-9.-]+$/.test(key) || value.length === 0)
      return null

    pairs.push([key, value])
  }

  const [firstKey, firstValue] = pairs[0]!
  if (firstKey !== 'version' || firstValue !== POINTER_VERSION)
    return null

  const rest = pairs.slice(1)

  // Sorted, and strictly: two keys the same is ambiguous rather than
  // recoverable, and out of order means it was not written by this format.
  for (let index = 1; index < rest.length; index++) {
    if (rest[index]![0] <= rest[index - 1]![0])
      return null
  }

  const values = new Map(rest)
  const oid = values.get('oid')
  const rawSize = values.get('size')

  if (!oid || !rawSize)
    return null

  const colon = oid.indexOf(':')
  if (colon <= 0)
    return null

  const algorithm = oid.slice(0, colon)
  const hash = oid.slice(colon + 1)

  if (algorithm !== 'sha256' || !/^[0-9a-f]{64}$/.test(hash))
    return null

  // `Number` would accept `12.5`, `1e3`, `0x10` and leading spaces, every one
  // of which would then be written back out as a different pointer.
  if (!/^(?:0|[1-9][0-9]*)$/.test(rawSize))
    return null

  const size = Number(rawSize)
  if (!Number.isSafeInteger(size))
    return null

  const extras: Record<string, string> = {}
  for (const [key, value] of rest) {
    if (key !== 'oid' && key !== 'size')
      extras[key] = value
  }

  return { oid, algorithm, hash, size, extras }
}

/** Whether a blob is a pointer, without keeping what it said. */
export function isPointer(input: string | Uint8Array): boolean {
  return parsePointer(input) !== null
}

/**
 * Write a pointer.
 *
 * The sort is what makes this reproducible: the same file always produces the
 * same bytes, so the same git blob, whoever wrote it.
 */
export function formatPointer(pointer: {
  oid?: string
  hash?: string
  size: number
  extras?: Record<string, string>
}): string {
  const oid = pointer.oid ?? (pointer.hash ? `sha256:${pointer.hash}` : '')
  const hash = oid.startsWith('sha256:') ? oid.slice('sha256:'.length) : ''

  if (!/^[0-9a-f]{64}$/.test(hash))
    throw new Error('A pointer needs a sha256 oid of 64 hex characters')

  if (!Number.isSafeInteger(pointer.size) || pointer.size < 0)
    throw new Error('A pointer needs a size in whole bytes')

  const fields: Array<[string, string]> = [
    ['oid', `sha256:${hash}`],
    ['size', String(pointer.size)],
  ]

  for (const [key, value] of Object.entries(pointer.extras ?? {})) {
    if (key === 'oid' || key === 'size' || key === 'version')
      continue
    if (!/^[a-z0-9.-]+$/.test(key))
      throw new Error(`A pointer key may only contain a-z, 0-9, dot and dash: ${key}`)
    if (value.includes('\n'))
      throw new Error(`A pointer value may not contain a newline: ${key}`)

    fields.push([key, value])
  }

  fields.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

  const lines = [`version ${POINTER_VERSION}`, ...fields.map(([key, value]) => `${key} ${value}`)]

  return `${lines.join('\n')}\n`
}
