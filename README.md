<p align="center"><img src=".github/art/cover.jpg" alt="Social Card of this repo"></p>

[![npm version][npm-version-src]][npm-version-href]
[![GitHub Actions][github-actions-src]][github-actions-href]
[![Commitizen friendly](https://img.shields.io/badge/commitizen-friendly-brightgreen.svg)](http://commitizen.github.io/cz-cli/)

# ts-git-lfs

Git Large File Storage, in TypeScript. Pointer files, the batch API, an object
store and file locking - as four separable pieces rather than one server you
have to adopt whole.

## Why

A repository tracked by LFS does not contain its large files. It contains a few
lines of text naming them, and a server somewhere holds the bytes. That server
is not complicated, but it is exacting: a pointer is hashed by git like any
other blob, so an implementation that disagrees about a trailing newline
produces a different blob for the same file, and a store that accepts bytes
without checking them returns the wrong file forever.

This package is those rules, written down and tested.

## Install

```bash
bun add ts-git-lfs
```

## Usage

### Pointer files

```ts
import { formatPointer, isPointer, parsePointer } from 'ts-git-lfs'

isPointer(await Bun.file('design.psd').text())

const pointer = parsePointer(text)
// { oid: 'sha256:4d7a…', hash: '4d7a…', size: 12345, extras: {} }

formatPointer({ hash: '4d7a…', size: 12345 })
// version https://git-lfs.github.com/spec/v1
// oid sha256:4d7a…
// size 12345
```

Reading is stricter than writing on purpose. Anything that is not exactly a
pointer is not a pointer, because a file that merely *starts* like one is a
file, and treating it as a pointer replaces somebody's content with a download.

### A server

`handleRequest` takes a `Request` and returns a `Response`, so it drops into
`Bun.serve`, into a route in your framework, or into a test with no server at
all. It returns `null` when the path is not part of the LFS API, so you can
mount it inside a larger router.

```ts
import { handleRequest, MemoryLockStore, ObjectStore } from 'ts-git-lfs'

const objects = new ObjectStore('.git/lfs/objects')
const locks = new MemoryLockStore()

Bun.serve({
  async fetch(request) {
    const response = await handleRequest(request, {
      objects,
      locks,
      endpoint: 'https://forge.example/owner/repo.git/info/lfs',
      authorize: async req => ({ actor: await whoIsThis(req), read: true, write: true }),
    })

    return response ?? myOwnRoutes(request)
  },
})
```

Authentication is a function you supply. This package will not invent one: your
host already knows who is asking and what they may do, and a second opinion
about that is a security bug waiting for the two to disagree.

### The decisions, without the transport

Everything that decides anything is pure and exported, so you can keep your own
storage, your own auth and your own router:

```ts
import { parseBatchRequest, planBatch } from 'ts-git-lfs'

const parsed = parseBatchRequest(await request.json())
if ('rejection' in parsed)
  return error(parsed.rejection)

const answer = planBatch(parsed.request, {
  endpoint,
  state: oid => ({ exists: myStore.has(oid) }),
})
```

### CLI

```bash
ts-git-lfs serve --root ./lfs --port 8080 --write   # a server, for trying it against a real client
ts-git-lfs pointer design.psd                       # read a pointer, or say it is not one
ts-git-lfs hash design.psd                          # write the pointer that would stand in for a file
```

## What is implemented

- **Pointer files** - reading, writing, and the strictness that keeps a git blob reproducible
- **Batch API** - `download` and `upload`, per-object errors, the `basic` transfer adapter
- **Objects** - content-addressed storage in git-lfs's own layout, streamed on the way out, verified on the way in
- **Verify** - the callback a client makes after an upload
- **Locking** - take, list, verify, release, and the rule that only the owner or somebody trusted may break one

The `basic` transfer adapter is the only one offered, deliberately: every client
must implement it, so a server that speaks only `basic` works with all of them.

## Storage layout

Objects are sharded by the first two bytes of their digest, which is git-lfs's
own layout - a store written by this package is one the official client can
read, and vice versa.

```
4d/7a/4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393
```

## Testing

```bash
bun test
```

## Changelog

Please see our [releases](https://github.com/stackjs/ts-git-lfs/releases) page for more information on what has changed recently.

## Contributing

Please see [CONTRIBUTING](.github/CONTRIBUTING.md) for details.

## Community

For help, discussion about best practices, or any other conversation that would benefit from being searchable:

[Discussions on GitHub](https://github.com/stacksjs/ts-git-lfs/discussions)

For casual chit-chat with others using this package:

[Join the Stacks Discord Server](https://stacksjs.com/discord)

## Postcardware

“Software that is free, but hopes for a postcard.” We love receiving postcards from around the world showing where Stacks is being used! We showcase them on our website too.

Our address: Stacks.js, 12665 Village Ln #2306, Playa Vista, CA 90094, United States 🌎

## Sponsors

We would like to extend our thanks to the following sponsors for funding Stacks development. If you are interested in becoming a sponsor, please reach out to us.

- [JetBrains](https://www.jetbrains.com/)
- [The Solana Foundation](https://solana.com/)

## License

The MIT License (MIT). Please see [LICENSE](LICENSE.md) for more information.

Made with 💙

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/ts-git-lfs?style=flat-square
[npm-version-href]: https://npmjs.com/package/ts-git-lfs
[github-actions-src]: https://img.shields.io/github/actions/workflow/status/stacksjs/ts-git-lfs/ci.yml?style=flat-square&branch=main
[github-actions-href]: https://github.com/stacksjs/ts-git-lfs/actions?query=workflow%3Aci
