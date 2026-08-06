import { describe, expect, it } from 'bun:test'
import { hashObject, isValidOid, normalizeOid, objectPath, objectPathSegments, verifyObject } from '../src/oid'

const OID = '4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393'

describe('normalizeOid', () => {
  it('takes the digest out of a prefixed or bare id', () => {
    expect(normalizeOid(`sha256:${OID}`)).toBe(OID)
    expect(normalizeOid(OID)).toBe(OID)
  })

  it('lower-cases, because the store is one directory per digest', () => {
    expect(normalizeOid(OID.toUpperCase())).toBe(OID)
  })

  it('refuses anything that is not one', () => {
    expect(normalizeOid('sha1:abc')).toBeNull()
    expect(normalizeOid('')).toBeNull()
    expect(normalizeOid(null)).toBeNull()
    expect(normalizeOid(42)).toBeNull()
    expect(normalizeOid(`${OID}00`)).toBeNull()
  })
})

describe('objectPath', () => {
  /** git-lfs's own layout, so a store here is one its client can read. */
  it('shards by the first two bytes', () => {
    expect(objectPathSegments(OID)).toEqual(['4d', '7a', OID])
    expect(objectPath(OID)).toBe(`4d/7a/${OID}`)
  })

  it('refuses to build a path from something that is not an oid', () => {
    expect(() => objectPathSegments('../../etc/passwd')).toThrow()
  })
})

describe('verifyObject', () => {
  it('accepts bytes that hash to the id they arrived under', async () => {
    const bytes = new TextEncoder().encode('hello lfs\n')
    const oid = await hashObject(bytes)

    expect(await verifyObject(bytes, { oid })).toMatchObject({ ok: true, oid, size: 10 })
  })

  /**
   * The check the whole store rests on. Accept the wrong bytes under a name
   * and every future download of that name is wrong.
   */
  it('refuses bytes that hash to something else', async () => {
    const result = await verifyObject(new TextEncoder().encode('tampered'), { oid: OID })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('do not hash')
  })

  it('refuses a size that disagrees, even when the hash is right', async () => {
    const bytes = new TextEncoder().encode('hello lfs\n')
    const oid = await hashObject(bytes)
    const result = await verifyObject(bytes, { oid, size: 99 })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('99')
  })

  it('refuses an id that is not a digest at all', async () => {
    expect((await verifyObject(new Uint8Array(0), { oid: 'nope' })).ok).toBe(false)
  })
})

describe('isValidOid', () => {
  it('is what everything else asks first', () => {
    expect(isValidOid(OID)).toBe(true)
    expect(isValidOid(OID.slice(1))).toBe(false)
    expect(isValidOid(undefined)).toBe(false)
  })
})
