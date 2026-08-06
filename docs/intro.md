# ts-git-lfs

Git Large File Storage, in TypeScript.

A repository tracked by LFS does not contain its large files. It contains a few
lines of text naming them, and a server somewhere holds the bytes. That server
is not complicated, but it is exacting.

## What is exacting about it

A pointer file is hashed by git like any other blob. Two implementations that
disagree about a trailing newline produce two different blobs for the same
file - so the format has to be reproduced byte for byte, and reading has to be
stricter than writing. A file that merely *starts* like a pointer is a file, and
treating it as a pointer replaces somebody's content with a download.

An object store is content-addressed. Accept the wrong bytes under a correct
name and every future download of that name is wrong, quietly, forever. So
nothing is written under its final name until it has been hashed and checked.

## The four pieces

They are separable on purpose. A host that already has storage, auth and a
router should be able to take only the parts it lacks.

- **[Pointer files](/usage#pointer-files)** - `parsePointer`, `formatPointer`, `isPointer`
- **[The batch API](/usage#the-batch-api)** - `parseBatchRequest`, `planBatch`, `negotiateTransfer`
- **[Object storage](/usage#object-storage)** - `ObjectStore`, `verifyObject`, `hashObject`
- **[Locking](/usage#locking)** - `createLock`, `releaseLock`, `verifyLocks`

Everything that decides anything is pure, so every rule is testable without a
socket, a disk or a database.

## What is not here

Authentication. Your host already knows who is asking and what they may do, and
a second opinion about that is a security bug waiting for the two to disagree.
`handleRequest` takes an `authorize` function and believes it.

Transfer adapters other than `basic`. Every client must implement `basic`, so a
server that speaks only `basic` works with all of them. The rest are optional
and mostly vendor-specific.
