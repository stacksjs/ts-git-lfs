/**
 * Naming an object, and deciding where it lives.
 *
 * An LFS object is named by the SHA-256 of its contents, so the name is a
 * claim anybody can check: the server never has to trust that the bytes it was
 * handed are the bytes that were asked for, and this module is what makes
 * checking cheap enough to always do.
 *
 * The on-disk layout is git-lfs's own, and matching it is deliberate - a
 * `.git/lfs/objects` directory written by this package is one the official
 * client can read, and vice versa. Two levels of two hex characters:
 *
 *     4d/7a/4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393
 */

/** A hex SHA-256, lower case, 64 characters. */
export type Oid = string

/** Whether a string is a usable object id. */
export function isValidOid(oid: unknown): oid is Oid {
  return typeof oid === 'string' && /^[0-9a-f]{64}$/.test(oid)
}

/**
 * The hex digest out of `sha256:<hex>` or a bare hex string.
 *
 * Returns null rather than throwing: this reads values that arrived over HTTP,
 * where a bad one is a 422 rather than a crash.
 */
export function normalizeOid(value: unknown): Oid | null {
  if (typeof value !== 'string')
    return null

  const lowered = value.trim().toLowerCase()
  const bare = lowered.startsWith('sha256:') ? lowered.slice('sha256:'.length) : lowered

  return isValidOid(bare) ? bare : null
}

/**
 * Where an object sits under a storage root, as path segments.
 *
 * Segments rather than a joined string, so the caller joins them with its own
 * platform's separator and this stays free of `node:path`.
 *
 * The sharding is not decoration. A single directory holding a million objects
 * is slow to list on every filesystem and impossible on some, and the first two
 * bytes of a hash spread evenly by construction.
 */
export function objectPathSegments(oid: Oid): string[] {
  if (!isValidOid(oid))
    throw new Error('An object path needs a 64 character hex sha256')

  return [oid.slice(0, 2), oid.slice(2, 4), oid]
}

/** The same, joined with `/`, which is what a URL and every POSIX path want. */
export function objectPath(oid: Oid): string {
  return objectPathSegments(oid).join('/')
}

/** The SHA-256 of some bytes, as an object id. */
export async function hashObject(bytes: Uint8Array | ArrayBuffer | string): Promise<Oid> {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(bytes as any)

  return hasher.digest('hex')
}

export interface Verification {
  ok: boolean
  /** What the bytes actually hash to. */
  oid: Oid
  /** How many bytes there were. */
  size: number
  /** Why it was refused, in words a client can show somebody. */
  reason?: string
}

/**
 * Check that bytes are the object they claim to be.
 *
 * Both halves matter and for different reasons. The hash is what makes the
 * store content-addressed at all - accept the wrong bytes under a name and
 * every future download of that name is wrong. The size is checked because the
 * client announced it in the batch request, and a mismatch means the two sides
 * disagree about what is being transferred even if the bytes hash correctly,
 * which is worth refusing rather than silently resolving.
 */
export async function verifyObject(
  bytes: Uint8Array,
  expected: { oid: unknown, size?: number },
): Promise<Verification> {
  const oid = await hashObject(bytes)
  const size = bytes.byteLength
  const wanted = normalizeOid(expected.oid)

  if (!wanted)
    return { ok: false, oid, size, reason: 'That object id is not a sha256 digest' }

  if (oid !== wanted)
    return { ok: false, oid, size, reason: 'The contents do not hash to the object id they were sent under' }

  if (typeof expected.size === 'number' && expected.size !== size)
    return { ok: false, oid, size, reason: `Expected ${expected.size} bytes and received ${size}` }

  return { ok: true, oid, size }
}
