/**
 * A server, and the two things worth doing to a store from a terminal.
 *
 * The library is the product; this exists so `ts-git-lfs serve` is enough to
 * try it against a real `git lfs push`, and so a store can be inspected without
 * writing a script.
 */

import { CLI } from '@stacksjs/clapp'
import { version } from '../package.json'
import { MemoryLockStore } from '../src/locks'
import { formatPointer, parsePointer } from '../src/pointer'
import { handleRequest } from '../src/server'
import { ObjectStore } from '../src/storage'

const cli = new CLI('ts-git-lfs')

cli
  .command('serve', 'Serve the LFS API over HTTP')
  .option('--port <port>', 'Port to listen on', { default: 8080 })
  .option('--root <root>', 'Directory to store objects in', { default: '.git/lfs/objects' })
  .option('--endpoint <endpoint>', 'The URL clients reach this server at')
  .option('--write', 'Allow anonymous uploads, which is only ever right locally')
  .example('ts-git-lfs serve --root ./lfs --port 8080 --write')
  .action(async (options: { port: number, root: string, endpoint?: string, write?: boolean }) => {
    const port = Number(options.port)
    const endpoint = options.endpoint ?? `http://localhost:${port}`
    const objects = new ObjectStore(options.root)
    const locks = new MemoryLockStore()

    Bun.serve({
      port,
      idleTimeout: 0,
      async fetch(request) {
        const response = await handleRequest(request, {
          objects,
          locks,
          endpoint,
          // Anonymous by default. A server that writes for anybody is only ever
          // right on a laptop, so it takes a flag and says so.
          authorize: () => ({
            actor: options.write ? { id: 'local', name: 'local' } : undefined,
            read: true,
            write: Boolean(options.write),
          }),
        })

        return response ?? new Response('Not found', { status: 404 })
      },
    })

    console.log(`ts-git-lfs listening on ${endpoint}`)
    console.log(`objects in ${options.root}${options.write ? '' : ', read only (pass --write to accept uploads)'}`)
  })

cli
  .command('pointer <file>', 'Read a pointer file, or say that it is not one')
  .action(async (file: string) => {
    const pointer = parsePointer(await Bun.file(file).text())

    if (!pointer) {
      console.log(`${file} is not an LFS pointer`)
      process.exitCode = 1

      return
    }

    console.log(`oid   ${pointer.oid}`)
    console.log(`size  ${pointer.size}`)
    for (const [key, value] of Object.entries(pointer.extras))
      console.log(`${key.padEnd(6)}${value}`)
  })

cli
  .command('hash <file>', 'Write the pointer that would stand in for a file')
  .action(async (file: string) => {
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(bytes)

    process.stdout.write(formatPointer({ hash: hasher.digest('hex'), size: bytes.byteLength }))
  })

cli.command('version', 'Show the version').action(() => console.log(version))

cli.version(version)
cli.help()
cli.parse()
