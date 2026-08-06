import type { Actor } from '../src/locks'
import { beforeEach, describe, expect, it } from 'bun:test'
import { createLock, listLocks, MemoryLockStore, normalizeLockPath, releaseLock, verifyLocks } from '../src/locks'

let store: MemoryLockStore

const ada: Actor = { id: 1, name: 'Ada Lovelace' }
const grace: Actor = { id: 2, name: 'Grace Hopper' }
const admin: Actor = { id: 3, name: 'The Admin', mayForce: true }

beforeEach(() => {
  store = new MemoryLockStore()
})

describe('normalizeLockPath', () => {
  /** Locking is a string comparison, so the strings have to agree. */
  it('brings the spellings of one path together', () => {
    expect(normalizeLockPath('src/art.psd')).toBe('src/art.psd')
    expect(normalizeLockPath('./src/art.psd')).toBe('src/art.psd')
    expect(normalizeLockPath('/src/art.psd')).toBe('src/art.psd')
    expect(normalizeLockPath('src//art.psd')).toBe('src/art.psd')
    expect(normalizeLockPath('src\\art.psd')).toBe('src/art.psd')
    expect(normalizeLockPath('  src/art.psd  ')).toBe('src/art.psd')
  })

  it('refuses a path that leaves the repository', () => {
    expect(normalizeLockPath('../secrets')).toBeNull()
    expect(normalizeLockPath('src/../../secrets')).toBeNull()
  })

  it('refuses nothing at all', () => {
    expect(normalizeLockPath('')).toBeNull()
    expect(normalizeLockPath('   ')).toBeNull()
    expect(normalizeLockPath(null)).toBeNull()
    expect(normalizeLockPath('x'.repeat(5000))).toBeNull()
  })
})

describe('createLock', () => {
  it('takes a lock nobody holds', async () => {
    const outcome = await createLock(store, ada, { path: 'src/art.psd' })

    expect(outcome.status).toBe(201)
    if ('lock' in outcome) {
      expect(outcome.lock.path).toBe('src/art.psd')
      expect(outcome.lock.owner.name).toBe('Ada Lovelace')
      expect(Date.parse(outcome.lock.locked_at)).toBeGreaterThan(0)
    }
  })

  /** The entire point: a lock that can be taken twice communicates nothing. */
  it('refuses one somebody else holds, and says who', async () => {
    await createLock(store, ada, { path: 'src/art.psd' })
    const outcome = await createLock(store, grace, { path: 'src/art.psd' })

    expect(outcome.status).toBe(409)
    if ('lock' in outcome)
      expect(outcome.lock.owner.name).toBe('Ada Lovelace')
  })

  /** A retry after a dropped connection is not a race with yourself. */
  it('hands back the lock you already hold rather than failing', async () => {
    const first = await createLock(store, ada, { path: 'src/art.psd' })
    const again = await createLock(store, ada, { path: 'src/art.psd' })

    expect(again.status).toBe(200)
    if ('lock' in first && 'lock' in again)
      expect(again.lock.id).toBe(first.lock.id)
  })

  it('locks the normalized path, so the spellings cannot each hold one', async () => {
    await createLock(store, ada, { path: 'src/art.psd' })

    expect((await createLock(store, grace, { path: './src//art.psd' })).status).toBe(409)
  })

  it('refuses a path it cannot make sense of', async () => {
    expect((await createLock(store, ada, { path: '../escape' })).status).toBe(422)
    expect((await createLock(store, ada, { path: 42 })).status).toBe(422)
  })
})

describe('releaseLock', () => {
  it('releases your own', async () => {
    const taken = await createLock(store, ada, { path: 'a.psd' })
    const id = 'lock' in taken ? taken.lock.id : ''

    expect((await releaseLock(store, ada, id)).status).toBe(200)
    expect(store.find('a.psd')).toBeNull()
  })

  it('refuses somebody else\'s without force', async () => {
    const taken = await createLock(store, ada, { path: 'a.psd' })
    const id = 'lock' in taken ? taken.lock.id : ''

    expect((await releaseLock(store, grace, id)).status).toBe(403)
    expect(store.find('a.psd')).not.toBeNull()
  })

  /** Force is not a flag anybody may set: people rely on locks. */
  it('refuses force from somebody not allowed to break locks', async () => {
    const taken = await createLock(store, ada, { path: 'a.psd' })
    const id = 'lock' in taken ? taken.lock.id : ''

    expect((await releaseLock(store, grace, id, true)).status).toBe(403)
    expect(store.find('a.psd')).not.toBeNull()
  })

  it('lets somebody who may break locks do it', async () => {
    const taken = await createLock(store, ada, { path: 'a.psd' })
    const id = 'lock' in taken ? taken.lock.id : ''

    expect((await releaseLock(store, admin, id, true)).status).toBe(200)
    expect(store.find('a.psd')).toBeNull()
  })

  it('has an answer for a lock that is not there', async () => {
    expect((await releaseLock(store, ada, 'nope')).status).toBe(404)
  })
})

describe('listLocks', () => {
  it('lists them, and filters by path', async () => {
    await createLock(store, ada, { path: 'a.psd' })
    await createLock(store, grace, { path: 'b.psd' })

    expect((await listLocks(store)).locks).toHaveLength(2)
    expect((await listLocks(store, { path: 'a.psd' })).locks[0]?.owner.name).toBe('Ada Lovelace')
  })
})

describe('verifyLocks', () => {
  /**
   * The split decides whether somebody's push is refused, so it goes by the
   * host's own identity - two people can share a display name.
   */
  it('splits mine from everybody else\'s', async () => {
    await createLock(store, ada, { path: 'mine.psd' })
    await createLock(store, grace, { path: 'theirs.psd' })

    const answer = await verifyLocks(store, ada)

    expect(answer.ours.map(lock => lock.path)).toEqual(['mine.psd'])
    expect(answer.theirs.map(lock => lock.path)).toEqual(['theirs.psd'])
  })

  it('does not leak the host\'s own identifiers to a client', async () => {
    await createLock(store, ada, { path: 'mine.psd' })
    const answer = await verifyLocks(store, ada)

    expect(Object.keys(answer.ours[0]!)).toEqual(['id', 'path', 'locked_at', 'owner'])
    expect(JSON.stringify(answer)).not.toContain('ownerId')
  })
})
