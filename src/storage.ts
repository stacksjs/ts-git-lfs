/**
 * Where the bytes actually live.
 *
 * Content-addressed on disk, in git-lfs's own layout, so a store written here
 * is one the official client can read. The whole surface is four operations -
 * has, read, write, remove - because that is all the batch API needs, and a
 * store that can do less is a store that can be swapped for S3 later without
 * anything above it noticing.
 *
 * Two rules the write path will not bend on:
 *
 * - **Nothing is written under its final name until it is known to be correct.**
 *   Bytes land in a temporary file, get hashed, and are moved into place only if
 *   the hash matches. A store is content-addressed or it is nothing: one wrong
 *   object under a correct name poisons every future download of it.
 * - **A rename, not a copy.** On one filesystem it is atomic, so a reader
 *   either sees the whole object or no object, never a half-written one.
 */

import type { Oid } from './oid'
import { mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { isValidOid, objectPathSegments, verifyObject } from './oid'

export interface StoredObject {
  oid: Oid
  size: number
}

export interface WriteResult {
  ok: boolean
  oid?: Oid
  size?: number
  reason?: string
}

/**
 * A store rooted at a directory.
 *
 * The root is created on demand rather than in the constructor: a server that
 * is only ever asked about objects it does not have should not leave an empty
 * tree behind.
 */
export class ObjectStore {
  constructor(private readonly root: string) {}

  /** The absolute path an object would have. */
  pathFor(oid: Oid): string {
    return join(this.root, ...objectPathSegments(oid))
  }

  /** What the store holds under this id, or null. */
  async lookup(oid: string): Promise<StoredObject | null> {
    if (!isValidOid(oid))
      return null

    try {
      const info = await stat(this.pathFor(oid))

      return info.isFile() ? { oid, size: info.size } : null
    }
    catch {
      return null
    }
  }

  async has(oid: string): Promise<boolean> {
    return (await this.lookup(oid)) !== null
  }

  /** The whole object in memory. For anything large, prefer `stream`. */
  async read(oid: string): Promise<Uint8Array | null> {
    if (!(await this.has(oid)))
      return null

    return new Uint8Array(await Bun.file(this.pathFor(oid)).arrayBuffer())
  }

  /**
   * The object as a stream.
   *
   * The reason this package is worth having: an LFS object is by definition the
   * file somebody decided was too big for git, so the download path must never
   * hold one in memory.
   */
  stream(oid: string): ReturnType<typeof createReadStream> | null {
    if (!isValidOid(oid))
      return null

    return createReadStream(this.pathFor(oid))
  }

  /**
   * Store bytes under the id they hash to.
   *
   * `expected` is what the client said it was sending. It is checked rather
   * than trusted - that check is the only thing standing between a store and a
   * name that returns the wrong file forever.
   */
  async write(bytes: Uint8Array, expected: { oid: string, size?: number }): Promise<WriteResult> {
    const verified = await verifyObject(bytes, expected)
    if (!verified.ok)
      return { ok: false, reason: verified.reason }

    const oid = verified.oid
    const destination = this.pathFor(oid)

    // Already there, and content-addressed, so it is the same bytes by
    // definition. Writing again would be work for no change.
    if (await this.has(oid))
      return { ok: true, oid, size: verified.size }

    const temporary = `${destination}.incoming-${Bun.randomUUIDv7()}`

    try {
      await mkdir(join(this.root, ...objectPathSegments(oid).slice(0, 2)), { recursive: true })
      await writeFile(temporary, bytes)
      await rename(temporary, destination)

      return { ok: true, oid, size: verified.size }
    }
    catch (error) {
      // A failed write must not leave a temporary file behind that looks like
      // an object to anybody counting disk usage.
      await unlink(temporary).catch(() => {})

      return { ok: false, reason: `Could not store the object: ${error}` }
    }
  }

  /** Remove an object. Absent is success: the caller wanted it gone. */
  async remove(oid: string): Promise<boolean> {
    if (!isValidOid(oid))
      return false

    try {
      await rm(this.pathFor(oid), { force: true })

      return true
    }
    catch {
      return false
    }
  }
}
