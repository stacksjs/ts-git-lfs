import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashObject } from '../src/oid'
import { ObjectStore } from '../src/storage'

let root = ''
let store: ObjectStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ts-git-lfs-'))
  store = new ObjectStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const bytes = (text: string) => new TextEncoder().encode(text)

describe('ObjectStore', () => {
  it('stores bytes under the id they hash to, and reads them back', async () => {
    const content = bytes('the quick brown fox\n')
    const oid = await hashObject(content)

    expect(await store.write(content, { oid })).toMatchObject({ ok: true, oid, size: 20 })
    expect(await store.has(oid)).toBe(true)
    expect(new TextDecoder().decode((await store.read(oid))!)).toBe('the quick brown fox\n')
    expect(await store.lookup(oid)).toEqual({ oid, size: 20 })
  })

  /** git-lfs's own layout, so its client can read a store written here. */
  it('shards on disk the way git-lfs does', async () => {
    const content = bytes('shard me')
    const oid = await hashObject(content)
    await store.write(content, { oid })

    expect(store.pathFor(oid)).toBe(join(root, oid.slice(0, 2), oid.slice(2, 4), oid))
    expect(readdirSync(root)).toEqual([oid.slice(0, 2)])
  })

  /**
   * The rule the whole store rests on. One wrong object under a correct name
   * poisons every future download of it.
   */
  it('refuses bytes that do not hash to the id they were sent under', async () => {
    const result = await store.write(bytes('not what was promised'), { oid: 'a'.repeat(64) })

    expect(result.ok).toBe(false)
    expect(await store.has('a'.repeat(64))).toBe(false)
  })

  it('leaves nothing behind when a write is refused', async () => {
    await store.write(bytes('nope'), { oid: 'b'.repeat(64) })

    expect(readdirSync(root)).toEqual([])
  })

  it('refuses a size that disagrees with the bytes', async () => {
    const content = bytes('eight!!!')
    const oid = await hashObject(content)

    expect((await store.write(content, { oid, size: 99 })).ok).toBe(false)
  })

  /** Content-addressed: the same id is the same bytes, so there is nothing to do. */
  it('is happy to be told twice about the same object', async () => {
    const content = bytes('written twice')
    const oid = await hashObject(content)

    expect((await store.write(content, { oid })).ok).toBe(true)
    expect((await store.write(content, { oid })).ok).toBe(true)
    expect(await store.lookup(oid)).toEqual({ oid, size: content.byteLength })
  })

  it('stores an empty object, which is a legitimate file', async () => {
    const empty = new Uint8Array(0)
    const oid = await hashObject(empty)

    expect((await store.write(empty, { oid })).ok).toBe(true)
    expect(await store.lookup(oid)).toEqual({ oid, size: 0 })
  })

  it('has nothing to say about an object it does not hold', async () => {
    expect(await store.lookup('c'.repeat(64))).toBeNull()
    expect(await store.read('c'.repeat(64))).toBeNull()
    expect(await store.has('c'.repeat(64))).toBe(false)
  })

  it('treats an id that is not a digest as absent rather than as a path', async () => {
    expect(await store.lookup('../../etc/passwd')).toBeNull()
    expect(await store.has('../../etc/passwd')).toBe(false)
    expect(store.stream('../../etc/passwd')).toBeNull()
  })

  it('removes an object, and calls removing an absent one done', async () => {
    const content = bytes('temporary')
    const oid = await hashObject(content)
    await store.write(content, { oid })

    expect(await store.remove(oid)).toBe(true)
    expect(await store.has(oid)).toBe(false)
    expect(await store.remove(oid)).toBe(true)
  })

  it('streams, because an LFS object is by definition too big to want in memory', async () => {
    const content = bytes('streamed')
    const oid = await hashObject(content)
    await store.write(content, { oid })

    const chunks: Buffer[] = []
    for await (const chunk of store.stream(oid)!)
      chunks.push(chunk as Buffer)

    expect(Buffer.concat(chunks).toString()).toBe('streamed')
  })
})
