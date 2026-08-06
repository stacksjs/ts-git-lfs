/**
 * File locking.
 *
 * The half of LFS that is not about bytes. A binary file cannot be merged, so
 * two people editing one is not a conflict to resolve later - it is one of them
 * losing work. Locking is how a team says "I have this file" before the loss
 * happens rather than after.
 *
 * The rules are small and the consequences are not:
 *
 * - **A lock is per path, and taking one twice fails.** That is the entire
 *   point; a lock that can be taken twice communicates nothing.
 * - **Only the owner may release one**, unless the caller is explicitly acting
 *   with force, which a server should permit only to somebody who could rewrite
 *   the branch anyway.
 * - **Force is recorded rather than silent.** Somebody's lock was broken; the
 *   answer says whose.
 *
 * The store is an interface rather than a table, because a forge already has
 * somewhere to put this and should not gain a second one. What lives here is
 * the decisions, which are the part worth testing.
 *
 * Shapes are from `docs/api/locking.md` in git-lfs.
 */

export interface LockOwner {
  name: string
}

export interface Lock {
  id: string
  path: string
  /** ISO 8601, which the spec requires and clients display verbatim. */
  locked_at: string
  owner: LockOwner
}

export interface LockRecord extends Lock {
  /** Who holds it, in the host's own terms. Never sent to a client. */
  ownerId: string | number
  /** The ref it was taken against, when the client named one. */
  ref?: string
}

export interface LockStore {
  find: (path: string) => Promise<LockRecord | null> | LockRecord | null
  byId: (id: string) => Promise<LockRecord | null> | LockRecord | null
  list: (filter: { path?: string, id?: string, refspec?: string }) => Promise<LockRecord[]> | LockRecord[]
  create: (lock: LockRecord) => Promise<void> | void
  remove: (id: string) => Promise<void> | void
}

export interface Actor {
  id: string | number
  name: string
  /** Whether this actor may break somebody else's lock. */
  mayForce?: boolean
}

export type LockOutcome
  = | { status: 201, lock: Lock }
    | { status: 200, lock: Lock }
    | { status: 409, lock: Lock, message: string }
    | { status: 403, message: string }
    | { status: 404, message: string }
    | { status: 422, message: string }

/** What a client sees. The host's own ids never leave the process. */
export function publicLock(record: LockRecord): Lock {
  return { id: record.id, path: record.path, locked_at: record.locked_at, owner: { name: record.owner.name } }
}

/**
 * A path, cleaned up the way every caller has to agree on.
 *
 * Locking is a comparison of strings, so `./src/a.psd`, `src/a.psd` and
 * `src//a.psd` have to become one string or the lock protects nothing. Leading
 * slashes go too: a lock is relative to the repository root, and `/src/a.psd`
 * from a client means the same file.
 */
export function normalizeLockPath(input: unknown): string | null {
  if (typeof input !== 'string')
    return null

  const collapsed = input.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')

  if (collapsed === '' || collapsed.length > 4096)
    return null

  // `..` would let a lock claim a path outside the repository, which is
  // meaningless here and is the sort of string that becomes a path later.
  if (collapsed.split('/').some(segment => segment === '..' || segment === '.'))
    return null

  return collapsed
}

/**
 * Take a lock.
 *
 * Taking one you already hold answers 200 with the lock you have, rather than
 * failing: a client that retries after a dropped connection should not be told
 * it lost a race with itself.
 */
export async function createLock(
  store: LockStore,
  actor: Actor,
  input: { path: unknown, ref?: unknown },
  now: Date = new Date(),
): Promise<LockOutcome> {
  const path = normalizeLockPath(input.path)
  if (!path)
    return { status: 422, message: 'A lock needs a path inside the repository' }

  const existing = await store.find(path)

  if (existing) {
    if (String(existing.ownerId) === String(actor.id))
      return { status: 200, lock: publicLock(existing) }

    return { status: 409, lock: publicLock(existing), message: `${existing.owner.name} already holds a lock on ${path}` }
  }

  const record: LockRecord = {
    id: Bun.randomUUIDv7(),
    path,
    locked_at: now.toISOString(),
    owner: { name: actor.name },
    ownerId: actor.id,
    ref: typeof input.ref === 'string' ? input.ref : undefined,
  }

  await store.create(record)

  return { status: 201, lock: publicLock(record) }
}

/**
 * Release a lock.
 *
 * Somebody else's needs `force`, and `force` needs an actor allowed to use it.
 * A server that grants that to everybody has locking that does nothing, which
 * is worse than not having it: people rely on it.
 */
export async function releaseLock(
  store: LockStore,
  actor: Actor,
  id: string,
  force = false,
): Promise<LockOutcome> {
  const existing = await store.byId(id)
  if (!existing)
    return { status: 404, message: 'No such lock' }

  const mine = String(existing.ownerId) === String(actor.id)

  if (!mine && !force)
    return { status: 403, message: `${existing.owner.name} holds that lock. Unlock with force to break it.` }

  if (!mine && force && !actor.mayForce)
    return { status: 403, message: 'You may not break another person\'s lock in this repository' }

  await store.remove(existing.id)

  return { status: 200, lock: publicLock(existing) }
}

export interface LockList {
  locks: Lock[]
  next_cursor?: string
}

/** Every lock, or the ones matching a path or id. */
export async function listLocks(
  store: LockStore,
  filter: { path?: unknown, id?: unknown, refspec?: unknown } = {},
): Promise<LockList> {
  const path = typeof filter.path === 'string' ? normalizeLockPath(filter.path) ?? undefined : undefined
  const id = typeof filter.id === 'string' ? filter.id : undefined
  const refspec = typeof filter.refspec === 'string' ? filter.refspec : undefined

  const found = await store.list({ path, id, refspec })

  return { locks: found.map(publicLock) }
}

export interface VerifyList {
  ours: Lock[]
  theirs: Lock[]
  next_cursor?: string
}

/**
 * The list a push consults.
 *
 * Split into `ours` and `theirs` because that is the decision the client is
 * about to make: a lock of ours is a file we may push, and one of theirs stops
 * the push. The split has to be by the host's own identity rather than by
 * display name - two people can share a name, and the answer decides whether
 * somebody's work is refused.
 */
export async function verifyLocks(store: LockStore, actor: Actor, refspec?: unknown): Promise<VerifyList> {
  const found = await store.list({ refspec: typeof refspec === 'string' ? refspec : undefined })
  const ours: Lock[] = []
  const theirs: Lock[] = []

  for (const record of found)
    (String(record.ownerId) === String(actor.id) ? ours : theirs).push(publicLock(record))

  return { ours, theirs }
}

/**
 * A store backed by a Map, for a single process and for tests.
 *
 * Exported because a small server or a test suite should not have to write one,
 * and because having a reference implementation is what keeps `LockStore` an
 * interface somebody can actually satisfy.
 */
export class MemoryLockStore implements LockStore {
  private readonly locks = new Map<string, LockRecord>()

  find(path: string): LockRecord | null {
    for (const record of this.locks.values()) {
      if (record.path === path)
        return record
    }

    return null
  }

  byId(id: string): LockRecord | null {
    return this.locks.get(id) ?? null
  }

  list(filter: { path?: string, id?: string, refspec?: string }): LockRecord[] {
    return [...this.locks.values()].filter((record) => {
      if (filter.id && record.id !== filter.id)
        return false
      if (filter.path && record.path !== filter.path)
        return false
      if (filter.refspec && record.ref && record.ref !== filter.refspec)
        return false

      return true
    })
  }

  create(lock: LockRecord): void {
    this.locks.set(lock.id, lock)
  }

  remove(id: string): void {
    this.locks.delete(id)
  }
}
