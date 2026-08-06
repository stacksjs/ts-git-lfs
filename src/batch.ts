/**
 * The batch API.
 *
 * One request asks about many objects at once - "I am about to push these
 * hundred files, which of them do you already have?" - and the answer tells the
 * client, per object, where to put the bytes or where to get them. Everything
 * about LFS being usable over a slow link comes from this being one round trip
 * rather than a hundred.
 *
 * This module is the *decisions*, not the transport: what a request means, what
 * an answer should say, and which objects are refused and why. It touches no
 * disk and no network, so every rule below is testable directly. The parts that
 * do touch things are in `storage.ts` and `server.ts`.
 *
 * Shapes are from `docs/api/batch.md` in git-lfs.
 */

import type { Oid } from './oid'
import { normalizeOid } from './oid'

/** The media type every batch request and response uses. */
export const LFS_CONTENT_TYPE = 'application/vnd.git-lfs+json'

export type Operation = 'download' | 'upload'

export interface BatchObjectRequest {
  oid: string
  size: number
}

export interface BatchRequest {
  operation: Operation
  /** Transfer adapters the client can speak, in its order of preference. */
  transfers?: string[]
  /** The ref the operation is for, which a server may use to decide access. */
  ref?: { name?: string }
  objects: BatchObjectRequest[]
  /** The hash algorithm. Only `sha256` has ever been defined. */
  hash_algo?: string
}

export interface BatchAction {
  href: string
  header?: Record<string, string>
  /** Seconds from now. Named by the spec, which is why it is not camel case. */
  expires_in?: number
}

export interface BatchObjectError {
  code: number
  message: string
}

export interface BatchObjectResponse {
  oid: string
  size: number
  /** Present and true when the client need not send credentials again. */
  authenticated?: boolean
  actions?: { download?: BatchAction, upload?: BatchAction, verify?: BatchAction }
  error?: BatchObjectError
}

export interface BatchResponse {
  transfer: string
  objects: BatchObjectResponse[]
  hash_algo: string
}

/**
 * The only transfer adapter here.
 *
 * `basic` is a plain PUT to upload and a plain GET to download. The others in
 * the wild (`lfs-standalone-file`, `ssh`, and the multipart adapters various
 * hosts invented) are optional, and a server that offers only `basic` works
 * with every client, because every client must implement it.
 */
export const BASIC_TRANSFER = 'basic'

/** What the caller has to tell this module about each object it was asked about. */
export interface ObjectState {
  /** Whether the store already holds it. */
  exists: boolean
  /** Its size in the store, when it is there - used to catch a mismatch. */
  size?: number
}

export interface BatchPlanOptions {
  /** Where object URLs are rooted, with no trailing slash. */
  endpoint: string
  /** Looked up once per object by the caller, so this stays pure. */
  state: (oid: Oid) => ObjectState
  /** Added to every action, for a server that hands out short-lived tokens. */
  header?: Record<string, string>
  expiresIn?: number
  /** Set when the request arrived already authenticated, so the client stops asking. */
  authenticated?: boolean
  /** Refuse an upload over this many bytes. */
  maxBytes?: number
}

/** A request that could not be understood at all. */
export interface BatchRejection {
  status: number
  message: string
  documentationUrl?: string
}

/**
 * Read a batch request, refusing anything malformed.
 *
 * Strict on purpose. Every field here decides what a server is about to do with
 * bytes, and "close enough" at this layer becomes a wrong file later.
 */
export function parseBatchRequest(body: unknown): { request: BatchRequest } | { rejection: BatchRejection } {
  if (typeof body !== 'object' || body === null)
    return { rejection: { status: 422, message: 'The request body must be a JSON object' } }

  const raw = body as Record<string, unknown>
  const operation = raw.operation

  if (operation !== 'download' && operation !== 'upload')
    return { rejection: { status: 422, message: 'operation must be "download" or "upload"' } }

  // Only sha256 was ever defined. A client asking for something else is asking
  // for a guarantee this cannot make, so it is refused rather than ignored.
  if (raw.hash_algo !== undefined && raw.hash_algo !== 'sha256')
    return { rejection: { status: 422, message: 'Only the sha256 hash algorithm is supported' } }

  if (!Array.isArray(raw.objects))
    return { rejection: { status: 422, message: 'objects must be an array' } }

  const objects: BatchObjectRequest[] = []

  for (const entry of raw.objects) {
    if (typeof entry !== 'object' || entry === null)
      return { rejection: { status: 422, message: 'Every object must be a JSON object' } }

    const item = entry as Record<string, unknown>
    const oid = normalizeOid(item.oid)

    if (!oid)
      return { rejection: { status: 422, message: 'Every object needs a sha256 oid' } }

    // Not `>= 0` by accident: an empty file is a legitimate object, and its
    // size is zero.
    if (typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0)
      return { rejection: { status: 422, message: `Object ${oid} needs a size in whole bytes` } }

    objects.push({ oid, size: item.size })
  }

  const transfers = Array.isArray(raw.transfers)
    ? raw.transfers.filter((value): value is string => typeof value === 'string')
    : undefined

  const refName = typeof raw.ref === 'object' && raw.ref !== null
    ? (raw.ref as Record<string, unknown>).name
    : undefined

  return {
    request: {
      operation,
      objects,
      transfers,
      ref: typeof refName === 'string' ? { name: refName } : undefined,
      hash_algo: 'sha256',
    },
  }
}

/**
 * Whether the server and client share a transfer adapter.
 *
 * A client that lists none means `basic`, which is what the spec says and what
 * old clients do.
 */
export function negotiateTransfer(requested: string[] | undefined): string | null {
  if (!requested || requested.length === 0)
    return BASIC_TRANSFER

  return requested.includes(BASIC_TRANSFER) ? BASIC_TRANSFER : null
}

/**
 * Decide the answer for every object in a batch.
 *
 * The two operations are near mirror images, and the interesting cases are the
 * ones where they differ:
 *
 * - **download** of an object the store does not have is `404` *for that
 *   object*, not for the request. The client may well be asking about a hundred
 *   files of which one is missing, and it needs the other ninety-nine.
 * - **upload** of an object the store already has gets no `upload` action at
 *   all. That is how the client is told to skip it, and it is where all the
 *   speed of pushing a branch that mostly exists already comes from.
 * - A **size that disagrees** with what the store holds is refused rather than
 *   resolved. The oid is a hash of the contents, so two different sizes under
 *   one oid means somebody is confused about which file this is.
 */
export function planBatch(request: BatchRequest, options: BatchPlanOptions): BatchResponse {
  const endpoint = options.endpoint.replace(/\/+$/, '')
  const objects: BatchObjectResponse[] = []

  for (const wanted of request.objects) {
    const state = options.state(wanted.oid)
    const answer: BatchObjectResponse = { oid: wanted.oid, size: wanted.size }

    if (options.authenticated)
      answer.authenticated = true

    const href = `${endpoint}/objects/${wanted.oid}`
    const action: BatchAction = { href }

    if (options.header)
      action.header = { ...options.header }
    if (options.expiresIn !== undefined)
      action.expires_in = options.expiresIn

    if (request.operation === 'download') {
      if (!state.exists) {
        answer.error = { code: 404, message: 'Object does not exist' }
      }
      else if (state.size !== undefined && state.size !== wanted.size) {
        answer.error = {
          code: 422,
          message: `Object is ${state.size} bytes here and was asked for as ${wanted.size}`,
        }
      }
      else {
        answer.actions = { download: action }
      }

      objects.push(answer)
      continue
    }

    // Upload.
    if (options.maxBytes !== undefined && wanted.size > options.maxBytes) {
      answer.error = { code: 413, message: `Object is larger than the ${options.maxBytes} byte limit` }
      objects.push(answer)
      continue
    }

    if (state.exists && state.size !== undefined && state.size !== wanted.size) {
      answer.error = {
        code: 409,
        message: `An object with that id is already stored at ${state.size} bytes`,
      }
      objects.push(answer)
      continue
    }

    // Already here: no actions, which is the spec's way of saying "skip it".
    if (state.exists) {
      objects.push(answer)
      continue
    }

    const verify: BatchAction = { href: `${endpoint}/verify` }
    if (options.header)
      verify.header = { ...options.header }

    answer.actions = { upload: action, verify }
    objects.push(answer)
  }

  return { transfer: BASIC_TRANSFER, objects, hash_algo: 'sha256' }
}
