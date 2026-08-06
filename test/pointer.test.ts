import { describe, expect, it } from 'bun:test'
import { formatPointer, isPointer, MAX_POINTER_BYTES, parsePointer, POINTER_VERSION } from '../src/pointer'

/**
 * The pointer is hashed by git like any other blob, so two implementations
 * that disagree about a byte produce two different blobs for one file. These
 * pin the bytes, not the intent.
 */

const OID = '4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393'
const CANONICAL = `version ${POINTER_VERSION}\noid sha256:${OID}\nsize 12345\n`

describe('parsePointer', () => {
  it('reads the three required lines', () => {
    const pointer = parsePointer(CANONICAL)!

    expect(pointer.oid).toBe(`sha256:${OID}`)
    expect(pointer.algorithm).toBe('sha256')
    expect(pointer.hash).toBe(OID)
    expect(pointer.size).toBe(12345)
    expect(pointer.extras).toEqual({})
  })

  it('reads bytes as readily as a string, because a blob arrives as bytes', () => {
    expect(parsePointer(new TextEncoder().encode(CANONICAL))?.size).toBe(12345)
  })

  /** An empty file is a legitimate thing to track. */
  it('accepts a size of zero', () => {
    const zero = `version ${POINTER_VERSION}\noid sha256:${OID}\nsize 0\n`

    expect(parsePointer(zero)?.size).toBe(0)
  })

  it('keeps keys the spec does not define', () => {
    const extended = `version ${POINTER_VERSION}\next-0-zip sha256:abc\noid sha256:${OID}\nsize 12345\n`

    expect(parsePointer(extended)?.extras).toEqual({ 'ext-0-zip': 'sha256:abc' })
  })

  describe('refuses what is not a pointer', () => {
    it('a file with no trailing newline', () => {
      expect(parsePointer(CANONICAL.slice(0, -1))).toBeNull()
    })

    it('keys out of order, which no writer of this format produces', () => {
      expect(parsePointer(`version ${POINTER_VERSION}\nsize 12345\noid sha256:${OID}\n`)).toBeNull()
    })

    it('a duplicated key, which is ambiguous rather than recoverable', () => {
      expect(parsePointer(`version ${POINTER_VERSION}\noid sha256:${OID}\noid sha256:${OID}\nsize 1\n`)).toBeNull()
    })

    it('version anywhere but first', () => {
      expect(parsePointer(`oid sha256:${OID}\nsize 1\nversion ${POINTER_VERSION}\n`)).toBeNull()
    })

    it('a different spec url', () => {
      expect(parsePointer(`version https://example.com/v2\noid sha256:${OID}\nsize 1\n`)).toBeNull()
    })

    it('an oid that is not sha256', () => {
      expect(parsePointer(`version ${POINTER_VERSION}\noid sha1:${'a'.repeat(40)}\nsize 1\n`)).toBeNull()
    })

    it('an oid of the wrong length', () => {
      expect(parsePointer(`version ${POINTER_VERSION}\noid sha256:abc\nsize 1\n`)).toBeNull()
    })

    it('an uppercase digest, because the format is lower case', () => {
      expect(parsePointer(`version ${POINTER_VERSION}\noid sha256:${OID.toUpperCase()}\nsize 1\n`)).toBeNull()
    })

    /**
     * Every one of these is a number to `Number()` and none is a size. A
     * pointer that parsed them would write back different bytes than it read.
     */
    it.each(['12.5', '1e3', '0x10', ' 12', '+12', '-1', '012'])('a size written as %p', (size) => {
      expect(parsePointer(`version ${POINTER_VERSION}\noid sha256:${OID}\nsize ${size}\n`)).toBeNull()
    })

    it('a binary file that happens to be short', () => {
      expect(parsePointer(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull()
    })

    it('anything past the size a pointer can be', () => {
      const long = `version ${POINTER_VERSION}\noid sha256:${OID}\nsize 1\nx ${'y'.repeat(MAX_POINTER_BYTES)}\n`

      expect(parsePointer(long)).toBeNull()
    })

    it('a real file that merely starts like one', () => {
      expect(parsePointer(`version ${POINTER_VERSION}\n\nand then prose\n`)).toBeNull()
    })

    it('an empty file', () => {
      expect(parsePointer('')).toBeNull()
    })

    it('a line with no value', () => {
      expect(parsePointer(`version ${POINTER_VERSION}\noid \nsize 1\n`)).toBeNull()
    })
  })
})

describe('formatPointer', () => {
  it('writes the canonical bytes', () => {
    expect(formatPointer({ oid: `sha256:${OID}`, size: 12345 })).toBe(CANONICAL)
  })

  it('takes a bare hash as readily as a prefixed oid', () => {
    expect(formatPointer({ hash: OID, size: 12345 })).toBe(CANONICAL)
  })

  /** The sort is what makes the same file produce the same git blob. */
  it('sorts the keys, whatever order they arrived in', () => {
    const written = formatPointer({ hash: OID, size: 1, extras: { zebra: 'z', alpha: 'a' } })

    expect(written).toBe(`version ${POINTER_VERSION}\nalpha a\noid sha256:${OID}\nsize 1\nzebra z\n`)
  })

  it('ignores an attempt to override a required key through extras', () => {
    const written = formatPointer({ hash: OID, size: 1, extras: { size: '99', version: 'nope' } })

    expect(written).toBe(`version ${POINTER_VERSION}\noid sha256:${OID}\nsize 1\n`)
  })

  it('refuses a key or value the format cannot represent', () => {
    expect(() => formatPointer({ hash: OID, size: 1, extras: { 'Bad Key': 'x' } })).toThrow()
    expect(() => formatPointer({ hash: OID, size: 1, extras: { good: 'two\nlines' } })).toThrow()
  })

  it('refuses a size that is not whole bytes', () => {
    expect(() => formatPointer({ hash: OID, size: -1 })).toThrow()
    expect(() => formatPointer({ hash: OID, size: 1.5 })).toThrow()
  })

  it('refuses an oid that is not a sha256', () => {
    expect(() => formatPointer({ oid: 'sha1:abc', size: 1 })).toThrow()
  })

  /** The property that matters: what is written reads back the same. */
  it('round trips', () => {
    const written = formatPointer({ hash: OID, size: 987654321, extras: { 'ext-0-a': 'x' } })
    const read = parsePointer(written)!

    expect(read.hash).toBe(OID)
    expect(read.size).toBe(987654321)
    expect(formatPointer({ hash: read.hash, size: read.size, extras: read.extras })).toBe(written)
  })
})

describe('isPointer', () => {
  it('answers the question a checkout asks of every blob', () => {
    expect(isPointer(CANONICAL)).toBe(true)
    expect(isPointer('just a file\n')).toBe(false)
  })
})
