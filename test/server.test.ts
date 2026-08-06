import type { ServerOptions } from '../src/server'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryLockStore } from '../src/locks'
import { hashObject } from '../src/oid'
import { handleRequest, routeOf } from '../src/server'
import { ObjectStore } from '../src/storage'

const ENDPOINT = 'https://forge.example/owner/repo.git/info/lfs'
const ada = { id: 1, name: 'Ada Lovelace' }

let root = ''
let objects: ObjectStore
let options: ServerOptions

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ts-git-lfs-server-'))
  objects = new ObjectStore(root)
  options = {
    objects,
    locks: new MemoryLockStore(),
    endpoint: ENDPOINT,
    authorize: () => ({ actor: ada, read: true, write: true }),
  }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const post = (path: string, body: unknown) =>
  new Request(`${ENDPOINT}${path}`, { method: 'POST', body: JSON.stringify(body) })

async function store(text: string): Promise<{ oid: string, bytes: Uint8Array }> {
  const bytes = new TextEncoder().encode(text)
  const oid = await hashObject(bytes)
  await objects.write(bytes, { oid })

  return { oid, bytes }
}

describe('routeOf', () => {
  it('is the path past the endpoint', () => {
    expect(routeOf(new URL(`${ENDPOINT}/objects/batch`), ENDPOINT)).toBe('/objects/batch')
    expect(routeOf(new URL(ENDPOINT), ENDPOINT)).toBe('/')
  })

  /** Null lets a host mount this inside its own router without matching twice. */
  it('has nothing to say about a path that is not ours', () => {
    expect(routeOf(new URL('https://forge.example/elsewhere'), ENDPOINT)).toBeNull()
  })
})

describe('the batch endpoint', () => {
  it('answers an upload with somewhere to put the bytes', async () => {
    const response = await handleRequest(post('/objects/batch', {
      operation: 'upload',
      transfers: ['basic'],
      objects: [{ oid: 'a'.repeat(64), size: 3 }],
    }), options)

    expect(response!.status).toBe(200)
    expect(response!.headers.get('content-type')).toContain('application/vnd.git-lfs+json')

    const body: any = await response!.json()
    expect(body.transfer).toBe('basic')
    expect(body.objects[0].actions.upload.href).toBe(`${ENDPOINT}/objects/${'a'.repeat(64)}`)
  })

  it('answers a download for something it holds', async () => {
    const { oid } = await store('hello\n')
    const response = await handleRequest(post('/objects/batch', { operation: 'download', objects: [{ oid, size: 6 }] }), options)
    const body: any = await response!.json()

    expect(body.objects[0].actions.download.href).toBe(`${ENDPOINT}/objects/${oid}`)
  })

  it('refuses a client that cannot speak basic', async () => {
    const response = await handleRequest(post('/objects/batch', {
      operation: 'download',
      transfers: ['tus'],
      objects: [],
    }), options)

    expect(response!.status).toBe(422)
  })

  it('refuses an upload from somebody who may only read', async () => {
    const response = await handleRequest(
      post('/objects/batch', { operation: 'upload', objects: [] }),
      { ...options, authorize: () => ({ read: true, write: false }) },
    )

    expect(response!.status).toBe(403)
  })

  it('refuses a body that is not JSON', async () => {
    const request = new Request(`${ENDPOINT}/objects/batch`, { method: 'POST', body: 'not json' })

    expect((await handleRequest(request, options))!.status).toBe(422)
  })
})

describe('the object endpoint', () => {
  it('takes an upload and stores it', async () => {
    const bytes = new TextEncoder().encode('uploaded\n')
    const oid = await hashObject(bytes)
    const request = new Request(`${ENDPOINT}/objects/${oid}`, { method: 'PUT', body: bytes })

    expect((await handleRequest(request, options))!.status).toBe(200)
    expect(await objects.has(oid)).toBe(true)
  })

  /** The check the store rests on, reached through HTTP this time. */
  it('refuses bytes that do not hash to the id in the URL', async () => {
    const request = new Request(`${ENDPOINT}/objects/${'a'.repeat(64)}`, { method: 'PUT', body: 'tampered' })
    const response = await handleRequest(request, options)

    expect(response!.status).toBe(422)
    expect(await objects.has('a'.repeat(64))).toBe(false)
  })

  it('serves the bytes back with a length and no sniffing', async () => {
    const { oid } = await store('served\n')
    const response = await handleRequest(new Request(`${ENDPOINT}/objects/${oid}`), options)

    expect(response!.status).toBe(200)
    expect(response!.headers.get('content-length')).toBe('7')
    expect(response!.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response!.text()).toBe('served\n')
  })

  /** An object is its hash, so it can never change under its own name. */
  it('says the bytes are immutable, because they are', async () => {
    const { oid } = await store('immutable\n')
    const response = await handleRequest(new Request(`${ENDPOINT}/objects/${oid}`), options)

    expect(response!.headers.get('cache-control')).toContain('immutable')
  })

  it('answers HEAD with the headers and no body', async () => {
    const { oid } = await store('head\n')
    const response = await handleRequest(new Request(`${ENDPOINT}/objects/${oid}`, { method: 'HEAD' }), options)

    expect(response!.status).toBe(200)
    expect(response!.headers.get('content-length')).toBe('5')
    expect(await response!.text()).toBe('')
  })

  it('is a 404 for an object nobody stored', async () => {
    const response = await handleRequest(new Request(`${ENDPOINT}/objects/${'f'.repeat(64)}`), options)

    expect(response!.status).toBe(404)
  })

  it('refuses an upload over the limit before reading the body', async () => {
    const bytes = new TextEncoder().encode('too big for this server')
    const oid = await hashObject(bytes)
    const request = new Request(`${ENDPOINT}/objects/${oid}`, { method: 'PUT', body: bytes })
    const response = await handleRequest(request, { ...options, maxBytes: 4 })

    expect(response!.status).toBe(413)
  })
})

describe('the verify endpoint', () => {
  it('confirms what arrived', async () => {
    const { oid } = await store('verified\n')
    const response = await handleRequest(post('/verify', { oid, size: 9 }), options)

    expect(response!.status).toBe(200)
    expect(await response!.json()).toEqual({ oid, size: 9 })
  })

  it('is a 404 for something that never arrived', async () => {
    expect((await handleRequest(post('/verify', { oid: 'e'.repeat(64) }), options))!.status).toBe(404)
  })

  it('refuses a size the store disagrees with', async () => {
    const { oid } = await store('verified\n')

    expect((await handleRequest(post('/verify', { oid, size: 99 }), options))!.status).toBe(422)
  })
})

describe('the locking endpoints', () => {
  it('takes, lists, verifies and releases a lock', async () => {
    const taken = await handleRequest(post('/locks', { path: 'art.psd' }), options)
    expect(taken!.status).toBe(201)

    const id = (await taken!.json() as any).lock.id

    const listed: any = await (await handleRequest(new Request(`${ENDPOINT}/locks`), options))!.json()
    expect(listed.locks).toHaveLength(1)

    const verified: any = await (await handleRequest(post('/locks/verify', {}), options))!.json()
    expect(verified.ours).toHaveLength(1)
    expect(verified.theirs).toHaveLength(0)

    const released = await handleRequest(post(`/locks/${id}/unlock`, {}), options)
    expect(released!.status).toBe(200)
  })

  it('is a 409 with the holder named when somebody else has it', async () => {
    await handleRequest(post('/locks', { path: 'art.psd' }), options)

    const other = { ...options, authorize: () => ({ actor: { id: 2, name: 'Grace Hopper' }, read: true, write: true }) }
    const response = await handleRequest(post('/locks', { path: 'art.psd' }), other)

    expect(response!.status).toBe(409)
    expect((await response!.json() as any).lock.owner.name).toBe('Ada Lovelace')
  })

  it('will not lock for somebody it cannot name', async () => {
    const anonymous = { ...options, authorize: () => ({ read: true, write: true }) }

    expect((await handleRequest(post('/locks', { path: 'art.psd' }), anonymous))!.status).toBe(403)
  })

  it('says so plainly when a server does not implement locking', async () => {
    const response = await handleRequest(post('/locks', { path: 'a.psd' }), { ...options, locks: undefined })

    expect(response!.status).toBe(501)
  })
})

describe('the surface as a whole', () => {
  it('leaves a path that is not ours to the host', async () => {
    expect(await handleRequest(new Request('https://forge.example/elsewhere'), options)).toBeNull()
  })

  it('is a 404 for a path of ours that is nothing', async () => {
    expect((await handleRequest(new Request(`${ENDPOINT}/nonsense`), options))!.status).toBe(404)
  })

  it('defaults to anonymous read and no write when no host decides', async () => {
    const { oid } = await store('public\n')
    const bare = { objects, endpoint: ENDPOINT }

    expect((await handleRequest(new Request(`${ENDPOINT}/objects/${oid}`), bare))!.status).toBe(200)
    expect((await handleRequest(post('/objects/batch', { operation: 'upload', objects: [] }), bare))!.status).toBe(403)
  })
})
