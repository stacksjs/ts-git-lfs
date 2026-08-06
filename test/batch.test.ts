import type { BatchRequest } from '../src/batch'
import { describe, expect, it } from 'bun:test'
import { negotiateTransfer, parseBatchRequest, planBatch } from '../src/batch'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const ENDPOINT = 'https://forge.example/owner/repo.git/info/lfs'

const plan = (request: BatchRequest, has: Record<string, number | undefined> = {}) =>
  planBatch(request, {
    endpoint: ENDPOINT,
    state: oid => (oid in has ? { exists: true, size: has[oid] } : { exists: false }),
  })

describe('parseBatchRequest', () => {
  it('reads a request the client actually sends', () => {
    const parsed = parseBatchRequest({
      operation: 'upload',
      transfers: ['basic'],
      ref: { name: 'refs/heads/main' },
      objects: [{ oid: A, size: 10 }],
    })

    expect('request' in parsed).toBe(true)
    if ('request' in parsed) {
      expect(parsed.request.operation).toBe('upload')
      expect(parsed.request.objects).toEqual([{ oid: A, size: 10 }])
      expect(parsed.request.ref?.name).toBe('refs/heads/main')
    }
  })

  it('accepts an object of zero bytes', () => {
    const parsed = parseBatchRequest({ operation: 'upload', objects: [{ oid: A, size: 0 }] })

    expect('request' in parsed).toBe(true)
  })

  describe('refuses', () => {
    const rejected = (body: unknown) => {
      const parsed = parseBatchRequest(body)
      expect('rejection' in parsed).toBe(true)

      return 'rejection' in parsed ? parsed.rejection : null
    }

    it('an operation that is neither download nor upload', () => {
      expect(rejected({ operation: 'delete', objects: [] })?.status).toBe(422)
    })

    it('a hash algorithm this cannot honour', () => {
      expect(rejected({ operation: 'upload', hash_algo: 'sha1', objects: [] })?.message).toContain('sha256')
    })

    it('objects that are not an array', () => {
      expect(rejected({ operation: 'upload', objects: {} })).toBeTruthy()
    })

    it('an oid that is not a digest', () => {
      expect(rejected({ operation: 'upload', objects: [{ oid: 'nope', size: 1 }] })).toBeTruthy()
    })

    it('a size that is not whole bytes', () => {
      expect(rejected({ operation: 'upload', objects: [{ oid: A, size: 1.5 }] })).toBeTruthy()
      expect(rejected({ operation: 'upload', objects: [{ oid: A, size: -1 }] })).toBeTruthy()
      expect(rejected({ operation: 'upload', objects: [{ oid: A }] })).toBeTruthy()
    })

    it('a body that is not an object at all', () => {
      expect(rejected(null)).toBeTruthy()
      expect(rejected('a string')).toBeTruthy()
    })
  })
})

describe('negotiateTransfer', () => {
  it('takes basic, which every client must implement', () => {
    expect(negotiateTransfer(['basic'])).toBe('basic')
    expect(negotiateTransfer(['tus', 'basic'])).toBe('basic')
  })

  /** An old client that lists none means basic, per the spec. */
  it('reads silence as basic', () => {
    expect(negotiateTransfer(undefined)).toBe('basic')
    expect(negotiateTransfer([])).toBe('basic')
  })

  it('has no answer when nothing is shared', () => {
    expect(negotiateTransfer(['tus'])).toBeNull()
  })
})

describe('planBatch, downloading', () => {
  it('hands back a download action for what it holds', () => {
    const answer = plan({ operation: 'download', objects: [{ oid: A, size: 10 }] }, { [A]: 10 })

    expect(answer.objects[0]!.actions?.download?.href).toBe(`${ENDPOINT}/objects/${A}`)
    expect(answer.objects[0]!.error).toBeUndefined()
  })

  /**
   * Per object, not per request. A client asking about a hundred files with one
   * missing still needs the ninety-nine.
   */
  it('marks a missing object 404 without failing the batch', () => {
    const answer = plan({ operation: 'download', objects: [{ oid: A, size: 10 }, { oid: B, size: 20 }] }, { [A]: 10 })

    expect(answer.objects[0]!.actions?.download).toBeTruthy()
    expect(answer.objects[1]!.error).toEqual({ code: 404, message: 'Object does not exist' })
  })

  /** Two sizes under one hash means somebody is confused about which file this is. */
  it('refuses an object whose stored size disagrees', () => {
    const answer = plan({ operation: 'download', objects: [{ oid: A, size: 10 }] }, { [A]: 99 })

    expect(answer.objects[0]!.error?.code).toBe(422)
    expect(answer.objects[0]!.actions).toBeUndefined()
  })
})

describe('planBatch, uploading', () => {
  it('asks for the bytes it does not have, and for a verify afterwards', () => {
    const answer = plan({ operation: 'upload', objects: [{ oid: A, size: 10 }] })

    expect(answer.objects[0]!.actions?.upload?.href).toBe(`${ENDPOINT}/objects/${A}`)
    expect(answer.objects[0]!.actions?.verify?.href).toBe(`${ENDPOINT}/verify`)
  })

  /**
   * No actions is the spec's way of saying "skip it", and it is where all the
   * speed of pushing a branch that mostly exists already comes from.
   */
  it('says nothing about an object it already holds', () => {
    const answer = plan({ operation: 'upload', objects: [{ oid: A, size: 10 }] }, { [A]: 10 })

    expect(answer.objects[0]!.actions).toBeUndefined()
    expect(answer.objects[0]!.error).toBeUndefined()
  })

  it('refuses an upload that would collide at a different size', () => {
    const answer = plan({ operation: 'upload', objects: [{ oid: A, size: 10 }] }, { [A]: 99 })

    expect(answer.objects[0]!.error?.code).toBe(409)
  })

  it('refuses an object over the size limit before asking for the bytes', () => {
    const answer = planBatch(
      { operation: 'upload', objects: [{ oid: A, size: 5000 }] },
      { endpoint: ENDPOINT, state: () => ({ exists: false }), maxBytes: 1000 },
    )

    expect(answer.objects[0]!.error?.code).toBe(413)
    expect(answer.objects[0]!.actions).toBeUndefined()
  })
})

describe('planBatch, generally', () => {
  it('names the transfer and the hash it answered with', () => {
    const answer = plan({ operation: 'download', objects: [] })

    expect(answer.transfer).toBe('basic')
    expect(answer.hash_algo).toBe('sha256')
  })

  it('tolerates a trailing slash on the endpoint rather than doubling it', () => {
    const answer = planBatch(
      { operation: 'upload', objects: [{ oid: A, size: 1 }] },
      { endpoint: `${ENDPOINT}/`, state: () => ({ exists: false }) },
    )

    expect(answer.objects[0]!.actions?.upload?.href).toBe(`${ENDPOINT}/objects/${A}`)
  })

  it('carries the headers and expiry a host asked for onto every action', () => {
    const answer = planBatch(
      { operation: 'download', objects: [{ oid: A, size: 1 }] },
      { endpoint: ENDPOINT, state: () => ({ exists: true, size: 1 }), header: { Authorization: 'Bearer x' }, expiresIn: 60, authenticated: true },
    )

    expect(answer.objects[0]!.actions?.download?.header).toEqual({ Authorization: 'Bearer x' })
    expect(answer.objects[0]!.actions?.download?.expires_in).toBe(60)
    expect(answer.objects[0]!.authenticated).toBe(true)
  })
})
