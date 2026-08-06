/**
 * The HTTP surface.
 *
 * A `Request` in, a `Response` out, so it drops into Bun.serve, into a route in
 * somebody's framework, or into a test with no server at all. Nothing here
 * decides anything - the decisions are in `batch.ts` and `locks.ts`, where they
 * can be tested without a socket - and what is left is routing, content types,
 * and the two or three places where HTTP itself has an opinion.
 *
 * The endpoints, from `docs/api` in git-lfs:
 *
 *     POST  {base}/objects/batch      which objects, and where to put them
 *     PUT   {base}/objects/{oid}      the bytes, on upload
 *     GET   {base}/objects/{oid}      the bytes, on download
 *     POST  {base}/verify             confirm an upload landed
 *     POST  {base}/locks              take a lock
 *     GET   {base}/locks              list them
 *     POST  {base}/locks/verify       which are mine and which are not
 *     POST  {base}/locks/{id}/unlock  release one
 *
 * Authentication is a function the host supplies. This package will not invent
 * one: a forge already knows who is asking and what they may do, and a second
 * opinion about that is a security bug waiting for the two to disagree.
 */

import type { Actor, LockStore } from './locks'
import type { ObjectStore } from './storage'
import { LFS_CONTENT_TYPE, negotiateTransfer, parseBatchRequest, planBatch } from './batch'
import { createLock, listLocks, releaseLock, verifyLocks } from './locks'
import { normalizeOid } from './oid'

export interface Authorized {
  /** Who is asking, when the host could tell. */
  actor?: Actor
  /** Whether they may read. */
  read: boolean
  /** Whether they may write. */
  write: boolean
}

export interface ServerOptions {
  objects: ObjectStore
  locks?: LockStore
  /**
   * The absolute URL this API is rooted at, with no trailing slash - it is
   * handed to clients in every action href, so it has to be the URL they can
   * reach rather than the path this process sees.
   */
  endpoint: string
  /** Decides who is asking. Absent means anonymous read, no write. */
  authorize?: (request: Request) => Promise<Authorized> | Authorized
  /** Refuse an upload over this many bytes. */
  maxBytes?: number
  /** Seconds an action href stays usable, when the host issues short-lived ones. */
  expiresIn?: number
}

/** The error shape every LFS endpoint uses. */
export function lfsError(status: number, message: string, documentationUrl?: string): Response {
  return Response.json(
    documentationUrl ? { message, documentation_url: documentationUrl } : { message },
    { status, headers: { 'Content-Type': LFS_CONTENT_TYPE } },
  )
}

function lfsJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Content-Type': LFS_CONTENT_TYPE } })
}

/**
 * Everything after the endpoint's own path.
 *
 * Returns null when the request is not for this API at all, which is what lets
 * a host mount it inside a larger router without matching twice.
 */
export function routeOf(url: URL, endpoint: string): string | null {
  const base = new URL(endpoint)
  const prefix = base.pathname.replace(/\/+$/, '')

  if (!url.pathname.startsWith(prefix))
    return null

  const rest = url.pathname.slice(prefix.length)

  return rest === '' ? '/' : rest
}

/**
 * Handle one request.
 *
 * Returns null when the path is not part of this API, so a host can fall
 * through to its own routes.
 */
export async function handleRequest(request: Request, options: ServerOptions): Promise<Response | null> {
  const url = new URL(request.url)
  const route = routeOf(url, options.endpoint)

  if (route === null)
    return null

  const access: Authorized = options.authorize
    ? await options.authorize(request)
    : { read: true, write: false }

  // Batch.
  if (route === '/objects/batch' && request.method === 'POST') {
    let body: unknown
    try {
      body = await request.json()
    }
    catch {
      return lfsError(422, 'The request body must be JSON')
    }

    const parsed = parseBatchRequest(body)
    if ('rejection' in parsed)
      return lfsError(parsed.rejection.status, parsed.rejection.message)

    const { request: batch } = parsed

    // Checked before the transfer negotiation, because "you may not push here"
    // is a more useful answer than "we share no transfer adapter".
    const needed = batch.operation === 'upload' ? access.write : access.read
    if (!needed)
      return lfsError(403, batch.operation === 'upload' ? 'You may not write to this repository' : 'You may not read this repository')

    if (!negotiateTransfer(batch.transfers))
      return lfsError(422, 'This server only speaks the basic transfer adapter')

    // Looked up once here, so `planBatch` stays a pure function of what it was
    // told rather than something that touches a disk.
    const state = new Map<string, { exists: boolean, size?: number }>()
    for (const object of batch.objects) {
      const found = await options.objects.lookup(object.oid)
      state.set(object.oid, found ? { exists: true, size: found.size } : { exists: false })
    }

    return lfsJson(planBatch(batch, {
      endpoint: options.endpoint,
      state: oid => state.get(oid) ?? { exists: false },
      authenticated: Boolean(access.actor),
      maxBytes: options.maxBytes,
      expiresIn: options.expiresIn,
    }))
  }

  // The bytes.
  const objectMatch = route.match(/^\/objects\/([0-9a-f]{64})$/)
  if (objectMatch) {
    const oid = normalizeOid(objectMatch[1])!

    if (request.method === 'GET' || request.method === 'HEAD') {
      if (!access.read)
        return lfsError(403, 'You may not read this repository')

      const found = await options.objects.lookup(oid)
      if (!found)
        return lfsError(404, 'Object does not exist')

      // Streamed, never buffered: the whole reason a file is in LFS is that it
      // is too big to want a copy of in memory.
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(found.size),
        // An object is its hash, so it can never change under its own name.
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      }

      if (request.method === 'HEAD')
        return new Response(null, { headers })

      return new Response(Bun.file(options.objects.pathFor(oid)).stream(), { headers })
    }

    if (request.method === 'PUT') {
      if (!access.write)
        return lfsError(403, 'You may not write to this repository')

      const declared = request.headers.get('content-length')
      if (options.maxBytes !== undefined && declared && Number(declared) > options.maxBytes)
        return lfsError(413, `Object is larger than the ${options.maxBytes} byte limit`)

      const bytes = new Uint8Array(await request.arrayBuffer())

      if (options.maxBytes !== undefined && bytes.byteLength > options.maxBytes)
        return lfsError(413, `Object is larger than the ${options.maxBytes} byte limit`)

      const written = await options.objects.write(bytes, { oid })
      if (!written.ok)
        return lfsError(422, written.reason ?? 'That object could not be stored')

      return new Response(null, { status: 200 })
    }

    return lfsError(405, 'That method is not allowed on an object')
  }

  // Verify: the client asking whether what it sent arrived.
  if (route === '/verify' && request.method === 'POST') {
    if (!access.read)
      return lfsError(403, 'You may not read this repository')

    let body: any
    try {
      body = await request.json()
    }
    catch {
      return lfsError(422, 'The request body must be JSON')
    }

    const oid = normalizeOid(body?.oid)
    if (!oid)
      return lfsError(422, 'verify needs a sha256 oid')

    const found = await options.objects.lookup(oid)
    if (!found)
      return lfsError(404, 'Object does not exist')

    // The size is part of the answer because it is the one thing the hash does
    // not prove to a client that has not downloaded the object.
    if (typeof body?.size === 'number' && body.size !== found.size)
      return lfsError(422, `Object is ${found.size} bytes here and was verified as ${body.size}`)

    return lfsJson({ oid, size: found.size })
  }

  // Locks.
  if (route.startsWith('/locks')) {
    if (!options.locks)
      return lfsError(501, 'This server does not implement locking')

    if (!access.actor)
      return lfsError(403, 'Locking needs to know who you are')

    if (route === '/locks' && request.method === 'POST') {
      if (!access.write)
        return lfsError(403, 'You may not write to this repository')

      const body: any = await request.json().catch(() => null)
      const outcome = await createLock(options.locks, access.actor, { path: body?.path, ref: body?.ref?.name })

      if (outcome.status === 201 || outcome.status === 200)
        return lfsJson({ lock: outcome.lock }, outcome.status)
      if (outcome.status === 409)
        return lfsJson({ lock: outcome.lock, message: outcome.message }, 409)

      return lfsError(outcome.status, outcome.message)
    }

    if (route === '/locks' && request.method === 'GET') {
      if (!access.read)
        return lfsError(403, 'You may not read this repository')

      return lfsJson(await listLocks(options.locks, {
        path: url.searchParams.get('path') ?? undefined,
        id: url.searchParams.get('id') ?? undefined,
        refspec: url.searchParams.get('refspec') ?? undefined,
      }))
    }

    if (route === '/locks/verify' && request.method === 'POST') {
      if (!access.read)
        return lfsError(403, 'You may not read this repository')

      const body: any = await request.json().catch(() => ({}))

      return lfsJson(await verifyLocks(options.locks, access.actor, body?.ref?.name))
    }

    const unlockMatch = route.match(/^\/locks\/([^/]+)\/unlock$/)
    if (unlockMatch && request.method === 'POST') {
      if (!access.write)
        return lfsError(403, 'You may not write to this repository')

      const body: any = await request.json().catch(() => ({}))
      const outcome = await releaseLock(options.locks, access.actor, unlockMatch[1]!, body?.force === true)

      if (outcome.status === 200)
        return lfsJson({ lock: outcome.lock })

      return lfsError(outcome.status, 'message' in outcome ? outcome.message : 'That lock could not be released')
    }
  }

  return lfsError(404, 'No such endpoint')
}
