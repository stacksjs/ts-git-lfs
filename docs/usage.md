# Usage

## Pointer files

A pointer is what git stores in place of the large file. It is three lines, and
the bytes matter: git hashes it like any other blob.

```ts
import { formatPointer, isPointer, parsePointer } from 'ts-git-lfs'

const pointer = parsePointer(await Bun.file('design.psd').text())
// null, or { oid, algorithm, hash, size, extras }
```

`parsePointer` returns `null` rather than throwing, because "is this a pointer"
is a question asked of every blob in a checkout and the answer is usually no.

It refuses anything that is not exactly a pointer: no trailing newline, keys out
of order, a duplicated key, an uppercase digest, a size written as `1e3` or
`012`. Each of those would read as valid and then write back different bytes.

```ts
formatPointer({ hash: '4d7a…', size: 12345 })
```

Keys are sorted, so the same file always produces the same bytes and therefore
the same git blob, whoever wrote it.

## The batch API

One request asks about many objects - "I am about to push these hundred files,
which do you already have?" All of LFS being usable over a slow link comes from
this being one round trip.

```ts
import { parseBatchRequest, planBatch } from 'ts-git-lfs'

const parsed = parseBatchRequest(await request.json())
if ('rejection' in parsed)
  return error(parsed.rejection.status, parsed.rejection.message)

const answer = planBatch(parsed.request, {
  endpoint: 'https://forge.example/owner/repo.git/info/lfs',
  state: oid => ({ exists: myStore.has(oid), size: myStore.sizeOf(oid) }),
})
```

The interesting cases are where the two operations differ:

- **Downloading** something absent is `404` *for that object*, not for the
  request. A client asking about a hundred files with one missing still needs
  the other ninety-nine.
- **Uploading** something already stored gets no `upload` action at all. That is
  how a client is told to skip it, and where the speed of pushing a
  mostly-existing branch comes from.
- A **size that disagrees** is refused rather than resolved. The oid is a hash of
  the contents, so two sizes under one oid means somebody is confused about
  which file this is.

## Object storage

```ts
import { ObjectStore } from 'ts-git-lfs'

const store = new ObjectStore('.git/lfs/objects')

await store.write(bytes, { oid })   // verified before it is stored
await store.lookup(oid)             // { oid, size } or null
store.stream(oid)                   // never buffered: it is a large file
```

Nothing is written under its final name until it is known to be correct. Bytes
land in a temporary file, get hashed, and are renamed into place only if the
hash matches - a rename, so a reader sees the whole object or no object.

## Locking

A binary file cannot be merged, so two people editing one is not a conflict to
resolve later; it is one of them losing work.

```ts
import { createLock, MemoryLockStore, releaseLock, verifyLocks } from 'ts-git-lfs'

const locks = new MemoryLockStore()

await createLock(locks, actor, { path: 'src/art.psd' })
await verifyLocks(locks, actor)   // { ours, theirs }
await releaseLock(locks, actor, id, force)
```

`LockStore` is an interface rather than a table, because a forge already has
somewhere to put this and should not gain a second one. `MemoryLockStore` is a
reference implementation, and what the tests use.

Only the owner may release a lock, unless the caller is explicitly acting with
`force` *and* is allowed to. A server that grants that to everybody has locking
that does nothing, which is worse than not having it, because people rely on it.

## A whole server

```ts
import { handleRequest, MemoryLockStore, ObjectStore } from 'ts-git-lfs'

Bun.serve({
  async fetch(request) {
    const response = await handleRequest(request, {
      objects: new ObjectStore('.git/lfs/objects'),
      locks: new MemoryLockStore(),
      endpoint: 'https://forge.example/owner/repo.git/info/lfs',
      authorize: async req => ({ actor: await whoIsThis(req), read: true, write: true }),
      maxBytes: 5 * 1024 * 1024 * 1024,
    })

    return response ?? myOwnRoutes(request)
  },
})
```

`handleRequest` returns `null` when the path is not part of the LFS API, so it
mounts inside a larger router without matching twice.
